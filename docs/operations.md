# Operations and cleanup

[Project overview](../README.md) | [App registrations](entra-app-registrations.md) | [Local development](local-development.md) | [Azure deployment](azure-deployment.md) | [Testing](testing.md)

## Server configuration

[.env.example](../.env.example) is the local template; [src/config.ts](../src/config.ts) defines runtime behavior. For Azure, set mapped values with `azd env set` and **re-provision**; the root `.env` does not configure the Container App.

| Variable | Required/default | Meaning |
| --- | --- | --- |
| `ENTRA_TENANT_ID` | Required | Token-issuing directory ID |
| `ENTRA_AUDIENCE` | Required | Exact expected `aud` value(s), comma-separated; bare API application ID for Entra v2 |
| `MCP_REQUIRED_SCOPE` | `mcp.invoke` | Short delegated scope required in `scp` |
| `ENTRA_ISSUER` | Tenant's `https://login.microsoftonline.com/<tenant>/v2.0` | Optional exact issuer override |
| `ENTRA_JWKS_URI` | Tenant's `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` | Optional signing-key endpoint override |
| `PORT` | `3000` | Integer listener port, 1-65535 |
| `HOST` | `127.0.0.1` | Listener address; container deployment sets `0.0.0.0` |
| `PUBLIC_BASE_URL` | `http://<HOST>:<PORT>` | Public resource/metadata/challenge base URL, without `/mcp`; trailing slashes are removed |

`ENTRA_CLIENT_APP_ID` is an **azd-generated output**, not a runtime server setting. `MCP_CLIENT_ID` and `REQUESTED_SCOPE` in the guides are client/test conventions, not settings read by the server. For automatic registration creation, the deployment module derives tenant/audience and uses `MCP_REQUIRED_SCOPE` when exposing the API scope.

## HTTP endpoints

| Method/path | Authentication | Behavior |
| --- | --- | --- |
| `POST /mcp` | Delegated bearer token and required scope | Stateless Streamable HTTP MCP request |
| `GET /mcp`, `DELETE /mcp` | Not checked | 405 with `Allow: POST`; no SSE stream/session teardown |
| `GET /healthz` | Public | Liveness JSON; does not prove Entra authentication works |
| `GET /.well-known/oauth-protected-resource` | Public | Resource metadata and tenant authority |

Authenticate before sending MCP JSON. Missing/invalid tokens return 401 and a discovery challenge; a valid token lacking the scope returns 403. The app authenticates before body parsing. Accepted MCP requests use `Content-Type: application/json` and `Accept: application/json, text/event-stream`.

## OAuth client integration

Configure a real client with its own application ID, the Entra tenant authority, registered callback URI, **full exposed scope**, and MCP endpoint. Use Authorization Code + PKCE for the public-client setup; the API does not handle OAuth callbacks or issue tokens. Register the client's callback, not the API URL merely because the API is remote.

Protected-resource metadata advertises the public base URL and tenant authority. **Current limitation:** `scopes_supported` is constructed as `<first configured audience>/<required scope>` in [src/app.ts](../src/app.ts). With the normal bare-GUID audience this is not the full `api://<api-app-id>/mcp.invoke` scope. It also does not represent all audience values or a custom Application ID URI.

Use the scope from **Expose an API** explicitly; do not promise discovery-only compatibility with every MCP client. The repository does not implement dynamic client registration or a browser CORS configuration. A client expecting those features needs separate integration work. Do not change the server's audience to a scope URI merely to change metadata.

## Security notes

- Tokens are verified on each MCP request; there is no persistent MCP session carrying authentication forward.
- Signature verification uses the tenant JWKS and RS256 with issuer/audience/time checks. The delegated permission comes from `scp`, not an application `roles` claim.
- `whoami` exposes only allow-listed claims, not raw tokens, groups, or arbitrary payload fields. Names/usernames/IDs may still be personal data.
- Keep issuer/JWKS overrides under trusted configuration control. Never expand audiences to include unrelated APIs to bypass authentication failures.
- Use HTTPS for externally reachable deployments; Azure ingress terminates TLS. Configure `PUBLIC_BASE_URL` correctly when using a reverse proxy/custom domain.
- Never put tokens or secrets in source, shell history, screenshots, or third-party token decoders. The validator/public-client setup needs no client secrets. Follow tenant policy for consent and least-privilege deployment access.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup reports missing configuration | Real tenant/audience values in `.env` or process environment; exported variables take precedence over `.env` |
| 401 `invalid_request` | `Authorization: Bearer <access-token>` header on every POST |
| 401 `invalid_token` | Token expiry, API v2 setting, tenant issuer, bare API-ID audience, trusted signing key; not a Graph/ID token |
| 403 `insufficient_scope` | `scp` contains the short configured scope; request the API's full exposed scope and arrange consent |
| Azure CLI cannot obtain a token | Correct tenant, exposed scope, Azure CLI preauthorization/tenant policy; your PKCE client's grant is not Azure CLI's grant |
| Redirect mismatch | Actual client callback is registered on the correct platform; this server has no callback route |
| Metadata has wrong public URL | `PUBLIC_BASE_URL` is the externally reachable base URL, not the MCP path |
| Client cannot use metadata's advertised scope | Current scope-format limitation above; configure the full exposed scope explicitly |
| Local container unreachable | Bind to `0.0.0.0` inside the container and publish the port; the local `.env` may override the image default |
| Azure changes have no effect | Correct selected azd environment; `azd provision` for parameter/config changes, `azd deploy` for image changes |
| First Azure request is slow | Scale-to-zero cold start; retry after startup. Minimum replicas can be changed in Bicep if continuous compute is acceptable |
| Newly provisioned revision is unhealthy | Placeholder image until real application deployment completes; inspect build/deploy failures |
| Entra setup/cleanup denied | Directory privileges and `az` tenant sign-in are separate from subscription RBAC and `azd` authentication |

Inspect Azure logs in the Container App's **Log stream** and Log Analytics. Confirm the revision/image, ingress, probes, and non-secret environment settings in the portal. If a registration script fails partway, inventory its printed IDs before retrying; it does not roll back.

## Cleanup

> **Permanent purge is irreversible.** Entra objects are tenant-wide, not contained in the Azure resource group. Never delete shared registrations or target apps by display name alone. Check tenant, application IDs, object IDs, and ownership first.

### Local teardown

Stop a foreground Node.js/watch process with **Ctrl+C**. For the named container from the local guide, run `docker stop entra-oauth-mcp-local`; its `--rm` option removes the container. Optionally remove the exact image with `docker image rm entra-oauth-mcp-server:local`.

Stopping the server does not delete registrations. Retain them if reused, or follow [independent registration cleanup](#independently-managed-registrations). Remove only the local `.env` file when you no longer need that configuration; do not assume removal revokes tokens or deletes Entra objects.

### Azure teardown

Select and inspect the intended environment before deleting:

```bash
azd env list
azd env select mcp-dev
azd env get-values
```

Confirm `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `CREATE_ENTRA_APP_REGISTRATIONS`, and generated app IDs/ownership tag, or the externally managed client ID. Save the exact IDs needed for verification/recovery before removing local environment state.

To **retain generated registrations**, set the opt-out before teardown:

```bash
azd env set ENTRA_PURGE_ON_DOWN false
```

Otherwise, in `true` mode automatic cleanup defaults to enabled. Sign Azure CLI into the correct Entra tenant so the hook can access Graph, then run:

```bash
az login --tenant "<registration-tenant-id>"
azd down
```

Review `azd` confirmation prompts; do not bypass them without verifying the deletion scope. `azd down` removes the Azure resources, including the registry and its images. It is not enough to stop the Container App if you want to remove all deployed resources.

#### Generated registrations: postdown cleanup

The Graph Bicep extension does not delete registrations on Azure teardown. This repository's [postdown hooks](../infra/hooks/) supply that cleanup **after successful** `azd down`:

- Run only if `CREATE_ENTRA_APP_REGISTRATIONS` is exactly `true` and `ENTRA_PURGE_ON_DOWN` is not `false`.
- Use generated API/client IDs and `ENTRA_APP_OWNERSHIP_TAG`; refuse missing/mismatched ownership.
- Delete and permanently purge the owned service principal before its application, for both registrations.
- Leave registrations untouched if teardown is cancelled/failed, or ownership cannot be verified.

Azure CLI and sufficient Entra privileges are required. Hook warnings do **not** fail `azd down`; read the final API/client summary. Successful Azure deletion does not prove every Entra object was purged. Older untagged registrations are intentionally not cleaned up.

If purge fails after soft deletion, the hooks can find owned objects in **Deleted items** on a subsequent successful teardown. You can also resolve failures manually using the exact IDs and the [steps below](#independently-managed-registrations). Keep environment state for recovery. Never remove ownership checks or change creation flags to force deletion of unrelated objects.

With `CREATE_ENTRA_APP_REGISTRATIONS=false`, the hook skips Entra cleanup entirely. Independently managed API/client registrations remain even if their IDs were saved in azd state.

### Independently managed registrations

This applies to local registrations, the Azure `false` path, and deliberate manual recovery. Coordinate with other users/deployments before deleting a shared registration.

**Portal:** In the correct tenant, inspect each **App registration** by application ID and each corresponding **Enterprise application** (service principal). Delete only the intended objects. Check the respective **Deleted applications** views where available; permanent deletion of retained soft-deleted objects may require Microsoft Graph and suitable directory privileges.

**CLI:** Sign in with `az login --tenant "<registration-tenant-id>"`. For each of the API and client, look up both IDs first. The following Bash example processes **one registration at a time** and stops on failure:

```bash
set -euo pipefail
APP_ID="<application-client-id-to-remove>"

# Inspect identity and record both object IDs before deleting anything.
az ad app show --id "$APP_ID" --query '{appId:appId,id:id,displayName:displayName}' -o json
az ad sp show --id "$APP_ID" --query '{appId:appId,id:id,displayName:displayName}' -o json

# Destructive: run only after confirming the exact objects above.
az ad sp delete --id "$APP_ID"
az ad app delete --id "$APP_ID"
```

If lookup reports an absent service principal, inspect whether it is already soft-deleted or was never created, and omit only its active-delete step. Do not suppress other lookup/permission failures. For partial-script failures, there may be only one application or no service principal.

Deleting an application is soft deletion, not proof of permanent removal. To inspect retained objects, query Graph using the application ID (substitute the literal ID below for each registration):

```bash
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.application?%24filter=appId%20eq%20%27<application-client-id>%27&%24select=id,appId,displayName"
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.servicePrincipal?%24filter=appId%20eq%20%27<application-client-id>%27&%24select=id,appId,displayName"
```

If permanent deletion is intended, confirm the returned **object IDs** against the recorded IDs, then purge the service principal before the application:

```bash
az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/<service-principal-object-id>"
az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/<application-object-id>"
```

For PowerShell, run each Azure CLI command on one line or use PowerShell backtick continuations, not Bash backslashes. Check `$LASTEXITCODE` after each command or use the `Invoke-Az` wrapper from the [registration guide](entra-app-registrations.md#powershell).

Repeat deliberately for the other registration. Do not purge the Microsoft Azure CLI first-party application: optional preauthorization did not make you its owner.

### Verify cleanup and remove local state

In Azure, verify the selected deployment's resource group/resources are absent. In Entra, verify the intended registrations and service principals are absent from active views and, if purge was requested, from Deleted items. A "not found" result is different from a permission/network error; do not treat every CLI failure as successful deletion.

After verification and any recovery, optionally remove only the specific local `.azure/<environment>/` state directory and `.env` you no longer need. Do not remove all environments or the repository. Removing local state alone never deletes remote resources and can lose IDs needed for recovery.
