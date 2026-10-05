# entra-oauth-mcp-server

A small, production-shaped [Model Context Protocol](https://modelcontextprotocol.io) server written in TypeScript.

- Official **MCP SDK** (`@modelcontextprotocol/sdk`) over the **Streamable HTTP** transport (stateless, JSON responses).
- Every MCP call requires a **Microsoft Entra ID** (Azure AD) v2 access token, validated against the tenant JWKS: signature, `iss`, `aud`, `exp`/`nbf`.
- Callers must hold a configurable delegated scope, `mcp.invoke` by default.
- Tools: `whoami` (returns safe identity claims from the token) and `echo`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Environment configuration + derived issuer/JWKS URLs |
| `src/auth.ts` | Bearer extraction, Entra JWT verification, scope enforcement, claim mapping |
| `src/mcp-server.ts` | MCP server + tool registrations bound to the caller's identity |
| `src/app.ts` | Express app: auth middleware, `/mcp`, `/healthz`, protected-resource metadata |
| `src/index.ts` | Process entrypoint |
| `test/auth.test.ts` | Unit tests for token/scope/claim handling and config |
| `test/server.test.ts` | HTTP tests: 401/403 paths and a full authenticated MCP round-trip |
| `Dockerfile` | Multi-stage production container image (non-root) |
| `azure.yaml` | Azure Developer CLI service definition |
| `infra/` | Bicep infrastructure (AVM modules) for Azure Container Apps |
| `infra/entra/` | Bicep module (Microsoft Graph extension) that `azd` can use to create the two Entra ID app registrations |
| `infra/hooks/` | `azd predown` hook scripts that purge the Entra app registrations (including from the recycle bin) on `azd down` |
| `.azure/deployment-plan.md` | Deployment plan and architecture decisions |

## 1. Entra ID app registrations

You need two registrations: the **API** (this server) and the **client** (whatever calls it). Create them either with the
portal steps in **1a–1b** or with one of the CLI scripts after those steps.

### 1a. API app registration — expose the scope

1. Entra admin center → **App registrations** → **New registration**. Name it e.g. `simple-mcp-server-api`. Register.
2. Note the **Application (client) ID** and **Directory (tenant) ID**.
3. **Expose an API** → **Add** next to *Application ID URI*. Accept the default `api://<api-client-id>` (or set a custom URI) → **Save**.
4. **Add a scope**:
   - Scope name: `mcp.invoke`
   - Who can consent: *Admins and users* (or admins only, your call)
   - Admin consent display name/description: e.g. "Invoke MCP tools"
   - State: **Enabled** → **Add scope**

   The full scope value is `api://<api-client-id>/mcp.invoke`.

No client secret or certificate is needed — this server only **validates** tokens, it never requests them.

### 1b. Client app registration — PKCE

1. **New registration**, name e.g. `simple-mcp-server-client`.
2. **Authentication** → **Add a platform**:
   - Desktop/CLI clients (the usual MCP case): choose **Mobile and desktop applications** and add the redirect URI `http://localhost:<port>/callback` (public client, Authorization Code + **PKCE**, no secret). Set *Allow public client flows* to **Yes**.
   - Browser-based clients: choose **Single-page application** with your app's redirect URI — SPA registrations enforce PKCE automatically.
3. **API permissions** → **Add a permission** → **My APIs** → select `simple-mcp-server-api` → **Delegated permissions** → check `mcp.invoke` → **Add permissions**. Grant admin consent if your tenant requires it.

### CLI alternative to 1a–1b — create both registrations end-to-end

Skip the portal steps in **1a–1b** and run one of the scripts below. They require `az login` as a user allowed to create app registrations and grant tenant-wide admin
consent, such as **Application Administrator** or **Cloud Application Administrator** (some tenants require a higher
privileged role for admin consent). The scripts create no client secrets; they create service principals so the
delegated permission grant and admin consent can be applied. They configure the public-client **Mobile and desktop
applications** redirect for the desktop/CLI PKCE case only; SPA registrations should still follow the portal steps in
**1b**. The scripts run `az ad app permission admin-consent` even though the scope type is `User`, so setup also works in
tenants that restrict user self-consent.

**PowerShell:**

```powershell
# Create the API app registration and expose api://<api-app-id>/mcp.invoke.
$apiDisplayName = "simple-mcp-server-api"
$clientDisplayName = "simple-mcp-server-client"
$redirectUri = "http://localhost:3000/callback"
$scopeName = "mcp.invoke"

$apiAppId = az ad app create --display-name $apiDisplayName --query appId -o tsv
$apiObjectId = az ad app show --id $apiAppId --query id -o tsv
az ad sp create --id $apiAppId | Out-Null

$scopeId = [guid]::NewGuid().ToString()
$identifierUri = "api://$apiAppId"
$apiPatch = @{
  identifierUris = @($identifierUri)
  api = @{
    requestedAccessTokenVersion = 2
    oauth2PermissionScopes = @(
      @{
        id = $scopeId
        value = $scopeName
        type = "User"
        isEnabled = $true
        adminConsentDisplayName = "Invoke MCP tools"
        adminConsentDescription = "Allows the app to invoke MCP tools on behalf of the signed-in user."
        userConsentDisplayName = "Invoke MCP tools"
        userConsentDescription = "Allows the app to invoke MCP tools on your behalf."
      }
    )
  }
} | ConvertTo-Json -Depth 10 -Compress

az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObjectId" --body $apiPatch

# Create the public client app for Authorization Code + PKCE.
$clientAppId = az ad app create `
  --display-name $clientDisplayName `
  --public-client-redirect-uris $redirectUri `
  --is-fallback-public-client true `
  --query appId -o tsv
az ad sp create --id $clientAppId | Out-Null

# Grant the client delegated access to the API scope, then admin-consent it.
az ad app permission add --id $clientAppId --api $apiAppId --api-permissions "$scopeId=Scope"
az ad app permission admin-consent --id $clientAppId

Write-Host "ENTRA_TENANT_ID = $(az account show --query tenantId -o tsv)"
Write-Host "API app ID = $apiAppId"
Write-Host "ENTRA_AUDIENCE = $apiAppId"
Write-Host "MCP_REQUIRED_SCOPE = $scopeName"
Write-Host "Client app ID = $clientAppId"
Write-Host "Requested scope = $identifierUri/$scopeName"
```

**Bash:**

```bash
# Create the API app registration and expose api://<api-app-id>/mcp.invoke.
apiDisplayName="simple-mcp-server-api"
clientDisplayName="simple-mcp-server-client"
redirectUri="http://localhost:3000/callback"
scopeName="mcp.invoke"

apiAppId=$(az ad app create --display-name "$apiDisplayName" --query appId -o tsv)
apiObjectId=$(az ad app show --id "$apiAppId" --query id -o tsv)
az ad sp create --id "$apiAppId" >/dev/null

scopeId=$(uuidgen)
identifierUri="api://$apiAppId"
apiPatch=$(cat <<JSON
{
  "identifierUris": ["$identifierUri"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [
      {
        "id": "$scopeId",
        "value": "$scopeName",
        "type": "User",
        "isEnabled": true,
        "adminConsentDisplayName": "Invoke MCP tools",
        "adminConsentDescription": "Allows the app to invoke MCP tools on behalf of the signed-in user.",
        "userConsentDisplayName": "Invoke MCP tools",
        "userConsentDescription": "Allows the app to invoke MCP tools on your behalf."
      }
    ]
  }
}
JSON
)

az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObjectId" --body "$apiPatch"

# Create the public client app for Authorization Code + PKCE.
clientAppId=$(az ad app create \
  --display-name "$clientDisplayName" \
  --public-client-redirect-uris "$redirectUri" \
  --is-fallback-public-client true \
  --query appId -o tsv)
az ad sp create --id "$clientAppId" >/dev/null

# Grant the client delegated access to the API scope, then admin-consent it.
az ad app permission add --id "$clientAppId" --api "$apiAppId" --api-permissions "$scopeId=Scope"
az ad app permission admin-consent --id "$clientAppId"

echo "ENTRA_TENANT_ID = $(az account show --query tenantId -o tsv)"
echo "API app ID = $apiAppId"
echo "ENTRA_AUDIENCE = $apiAppId"
echo "MCP_REQUIRED_SCOPE = $scopeName"
echo "Client app ID = $clientAppId"
echo "Requested scope = $identifierUri/$scopeName"
```

### Bicep alternative to 1a–1b — declarative, via `azd` and the Microsoft Graph Bicep extension

A third option: [`infra/entra/app-registrations.bicep`](infra/entra/app-registrations.bicep) creates and configures
both registrations declaratively, using the [Microsoft Graph Bicep
extension](https://learn.microsoft.com/en-us/graph/templates/bicep/overview) instead of `az ad app` commands. It
creates the same objects as the CLI scripts above — API app with the `mcp.invoke` scope, public-client app with the
desktop/CLI PKCE redirect, service principals for both, and the delegated permission grant with tenant-wide admin
consent — and is idempotent (`uniqueName` lets you re-run it safely). It also adds the client to the API's
"Authorized client applications" list (Expose an API blade), so Entra skips the consent prompt for this
client/scope combination — and, by default, also pre-authorizes the well-known Microsoft Azure CLI first-party app
(`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) for the same scope, so `az` can call the API without a consent prompt
either; set `ENTRA_AUTHORIZE_AZURE_CLI_CLIENT` to `false` to opt out.

Unlike the portal/CLI options, this isn't a separate step: it's a module wired into
[`infra/main.bicep`](infra/main.bicep) behind the `createEntraAppRegistrations` parameter, so it deploys as part of
the normal **section 5** `azd provision` / `azd up` flow — no standalone `az` invocation needed. When enabled, the
container app's `ENTRA_TENANT_ID` / `ENTRA_AUDIENCE` env vars are set automatically from the app it just created,
so you can skip setting `ENTRA_TENANT_ID` / `ENTRA_AUDIENCE` by hand:

```bash
azd env set CREATE_ENTRA_APP_REGISTRATIONS true
# Optional overrides — defaults shown:
azd env set ENTRA_API_DISPLAY_NAME simple-mcp-server-api
azd env set ENTRA_CLIENT_DISPLAY_NAME simple-mcp-server-client
azd env set ENTRA_CLIENT_REDIRECT_URI http://localhost:3000/callback
azd env set ENTRA_AUTHORIZE_AZURE_CLI_CLIENT true
azd env set ENTRA_AZURE_CLI_APP_ID 04b07795-8ddb-461a-bbee-02f9e1bf7b46

azd up
```

Requires the deploying principal to be allowed to create app registrations and grant tenant-wide admin consent (e.g.
Application Administrator / Cloud Application Administrator — some tenants require a higher-privileged role for
admin consent), in addition to the Azure RBAC role `azd` otherwise needs. Outputs mirror the CLI scripts' printed
values: `ENTRA_TENANT_ID`, `ENTRA_AUDIENCE`, `ENTRA_API_APP_ID`, `ENTRA_CLIENT_APP_ID`. By default the API app gets
`api://<api-app-id>` as its Application ID URI (matching the CLI scripts above), while `ENTRA_AUDIENCE` remains the
bare API app ID emitted in the `aud` claim (see 1c below) — `identifierUris` has no effect on token audience. SPA
client registrations still need the portal steps in **1b**.
Leave `createEntraAppRegistrations` at its default (`false`) to keep using registrations created by the portal or
CLI scripts above, as described in the rest of section 5.

#### Cleaning up on `azd down`

The Microsoft Graph Bicep extension does not delete app registrations when their resources are removed — this is
by design, so `azd down` alone leaves the API and client app registrations behind in Entra. When
`createEntraAppRegistrations` is `true`, this repo wires up a `postdown` [azd hook](infra/hooks/) (`infra/hooks/postdown-purge-entra-apps.sh`
on Linux/macOS, `infra/hooks/postdown-purge-entra-apps.ps1` on Windows, registered in [`azure.yaml`](azure.yaml)).
It runs only after `azd down` succeeds, then soft-deletes both app registrations and service principals and
permanently purges them from the Entra **Deleted items** recycle bin via Microsoft Graph. A cancelled or failed
teardown therefore leaves the registrations intact.

The hook requires `CREATE_ENTRA_APP_REGISTRATIONS=true` and verifies a per-subscription, per-azd-environment
ownership tag before deleting anything. New registrations use environment-specific names, so different azd
environments do not share registrations; existing registrations without the ownership tag are left untouched.
You can disable cleanup outright, even when azd created the apps:

```bash
azd env set ENTRA_PURGE_ON_DOWN false
```

Deleting and purging app registrations and service principals requires the appropriate privileged role (e.g.
Application Administrator / Cloud Application Administrator). The hook is best-effort: lookup/delete/purge errors
are printed as warnings and do not fail `azd down`. If a purge fails after soft deletion, a later successful
`azd down` retries the purge from Deleted items; you may still need to finish cleanup manually in the Entra admin
center.

### 1c. Token audience — the part people get wrong

When the client requests a token it must ask for the **API's** scope, not Microsoft Graph:

```
scope = <Requested scope from the script or portal> offline_access
```

For the default setup above, that scope is `api://<api-client-id>/mcp.invoke`.

That produces a v2 access token with:

- `aud` = `<api-client-id>` (the bare Application/client ID)
- `iss` = `https://login.microsoftonline.com/<tenant-id>/v2.0`
- `scp` containing `mcp.invoke`

Set `ENTRA_AUDIENCE` to the bare API app ID printed by the setup script. The `api://` value identifies the delegated
scope being requested; it is not the `aud` value in an Entra v2 access token. If you are unsure, decode a token at
[jwt.ms](https://jwt.ms) and copy the `aud` value. The server also accepts multiple exact claim values, comma-separated,
for deployments that intentionally support tokens from another issuer or token version:

```
ENTRA_AUDIENCE=11111111-1111-1111-1111-111111111111
```

> A Microsoft Graph token (`aud` = `00000003-0000-0000-c000-000000000000`) will always be rejected here, by design.

## 2. Configure and run locally

```bash
npm install
cp .env.example .env   # then paste the ENTRA_* / MCP_REQUIRED_SCOPE values printed in section 1
npm run dev            # watch mode
# or
npm run build && npm start
```

Environment variables (all documented in `.env.example`):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `ENTRA_TENANT_ID` | yes | – | Directory (tenant) ID; printed by the CLI scripts |
| `ENTRA_AUDIENCE` | yes | – | Expected `aud` value(s), comma-separated; for Entra v2 use the API application/client ID as a bare GUID |
| `MCP_REQUIRED_SCOPE` | no | `mcp.invoke` | Delegated scope required for every MCP call; printed by the CLI scripts |
| `ENTRA_ISSUER` | no | `https://login.microsoftonline.com/<tenant>/v2.0` | Expected `iss` |
| `ENTRA_JWKS_URI` | no | tenant v2 `discovery/v2.0/keys` | Signing key source |
| `PORT` / `HOST` | no | `3000` / `127.0.0.1` | Listener |
| `PUBLIC_BASE_URL` | no | `http://HOST:PORT` | Used in OAuth metadata and `WWW-Authenticate` |

No credentials are stored in code; `.env` is git-ignored.

### Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/mcp` | Bearer | Streamable HTTP MCP endpoint |
| `GET`/`DELETE` | `/mcp` | – | `405` (stateless server: no SSE stream or session teardown) |
| `GET` | `/healthz` | – | Liveness |
| `GET` | `/.well-known/oauth-protected-resource` | – | RFC 9728 metadata pointing clients at your tenant |

## 3. Verify with curl

Uses the values from section 1: `<tenant-id>` is the printed `ENTRA_TENANT_ID`, and `<requested-scope>` is the printed
`Requested scope` (`api://<api-client-id>/mcp.invoke` in the default setup). For this quick manual check, Azure CLI asks
for the same delegated scope your MCP client will request. If your tenant blocks Azure CLI from requesting that API scope,
use your client app's Authorization Code + PKCE flow instead.

```bash
az login --tenant <tenant-id>
TOKEN=$(az account get-access-token \
  --scope "<requested-scope>" \
  --query accessToken -o tsv)
```

PowerShell equivalent:

```powershell
az login --tenant <tenant-id>
$TOKEN = az account get-access-token --scope "<requested-scope>" --query accessToken -o tsv
```

**No token → 401 plus a discovery hint:**

```bash
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer error="invalid_request", error_description="Missing Authorization header.",
#   resource_metadata="http://127.0.0.1:3000/.well-known/oauth-protected-resource"
```

**Initialize with a token:**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

**List tools:**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

**Call `whoami`:**

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

Returns only non-sensitive identity claims:

```json
{
  "subject": "…", "objectId": "…", "tenantId": "…", "clientId": "…",
  "username": "user@contoso.com", "name": "Test User",
  "scopes": ["mcp.invoke"], "issuer": "…", "audience": "…",
  "issuedAt": 1750000000, "expiresAt": 1750003600
}
```

A token that is valid but lacks `mcp.invoke` gets `403` with `WWW-Authenticate: Bearer error="insufficient_scope", …, scope="mcp.invoke"`.

> On Windows PowerShell, `$TOKEN` from the block above works as-is; just use `curl.exe` instead of the `curl` alias
> (PowerShell's built-in `curl`/`Invoke-WebRequest` doesn't support these flags the same way).

## 4. Scripts

| Script | Action |
| --- | --- |
| `npm run dev` | Watch-mode server via `tsx` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Typecheck `src/` and `test/` |
| `npm test` | Vitest suite |

The tests never contact Entra: they generate a local RSA keypair, sign tokens with `jose`, and inject a verifier into the same code path, covering valid tokens, expiry, wrong issuer, wrong audience, untrusted signing key, missing/malformed bearer headers, missing scope, and claim redaction.

## 5. Deploy to Azure

The server deploys to **Azure Container Apps (Consumption)** with the Azure Developer CLI and Bicep.
Full rationale and architecture live in [`.azure/deployment-plan.md`](.azure/deployment-plan.md).

### What gets created

| Resource | Tier | Why |
| --- | --- | --- |
| Container App | 0.5 vCPU / 1 GiB, **min 0 / max 3** replicas | Scales to zero, so an idle server costs essentially nothing |
| Container Apps environment | Consumption workload profile | No fixed charge |
| Container Registry | Basic, **admin user disabled** | Image storage; pulls use a managed identity |
| Log Analytics workspace | PerGB2018, 30-day retention, 1 GB/day cap | Container logs, with a cap to avoid cost surprises |

Application Insights and Key Vault are intentionally **not** deployed: the app has no APM instrumentation, and it holds no
secrets (it only *validates* tokens). See the plan for details.

### Prerequisites

- [Azure Developer CLI](https://aka.ms/azd-install) (`azd`)
- Docker (used by `azd` to build the image)
- An Azure subscription, and the Entra registrations from section 1 (or let `azd` create them — see below)

### Deploy

```bash
azd auth login
azd env new mcp-dev

# Non-secret configuration. Use the values printed by the section 1 CLI script,
# or the equivalent values from your portal-created app registrations.
azd env set ENTRA_TENANT_ID   "<ENTRA_TENANT_ID>"
azd env set ENTRA_AUDIENCE    "<ENTRA_AUDIENCE>"
azd env set MCP_REQUIRED_SCOPE "<MCP_REQUIRED_SCOPE>"

azd up
```

Alternatively, skip creating the registrations beforehand and have `azd` do it as part of `provision` (see the
"Bicep alternative to 1a–1b" box in section 1):

```bash
azd env set CREATE_ENTRA_APP_REGISTRATIONS true
azd up
```

`azd up` builds the image, pushes it to the registry, provisions the infrastructure, and deploys. On completion it prints
the public endpoint, for example:

```
SERVICE_MCP_URI  https://ca-mcp-<token>.francecentral.azurecontainerapps.io
MCP_ENDPOINT     https://ca-mcp-<token>.francecentral.azurecontainerapps.io/mcp
```

Verify it the same way as locally:

```bash
curl -s "$SERVICE_MCP_URI/healthz"
curl -s "$SERVICE_MCP_URI/.well-known/oauth-protected-resource"
```

### Deployment notes

- **`HOST=0.0.0.0` is set in the container.** The app defaults to `127.0.0.1`; without this override the container would
  accept no external traffic. It is supplied as an environment variable, so no source change is needed.
- **`PUBLIC_BASE_URL` is derived automatically** from the Container Apps ingress FQDN inside Bicep, so the OAuth metadata
  document and the `WWW-Authenticate: resource_metadata=` hint are correct after a single `azd up`. Set the
  `publicBaseUrl` parameter only if you put a custom domain in front.
- **Add the deployed URL as a redirect URI** on your *client* registration before running an interactive OAuth flow.
- **Cold starts are expected.** `minReplicas: 0` is deliberate; the first request after an idle period pays a container
  start. Set `minReplicas: 1` in `infra/main.bicep` to trade cost for latency.
- **Entra parameters default to placeholder GUIDs** so the infrastructure can be provisioned before the registrations
  exist. The server will reject all tokens until real values are set with `azd env set` and redeployed, or until
  `CREATE_ENTRA_APP_REGISTRATIONS` is set to `true` so `azd` creates them for you.

## Security notes

- Tokens are verified on **every** MCP request; the server is stateless, so there is no session to hijack after the fact.
- Only allow-listed claims are returned by `whoami` — group, role, and raw-token data are never echoed back.
- `ENTRA_ISSUER`/`ENTRA_AUDIENCE` are enforced, so tokens minted for other APIs or tenants are rejected.
- Terminate TLS in front of this server (reverse proxy or platform ingress) and set `PUBLIC_BASE_URL` to the public `https://` URL.
