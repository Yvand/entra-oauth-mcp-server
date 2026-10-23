# Entra MCP demo plugin for Copilot Cowork

[Repository overview](../README.md) | [MCP server](../server/README.md)

This learning demo is a **Microsoft 365 Copilot Cowork plugin**, not a Copilot Chat declarative agent or a GitHub Copilot CLI plugin. One skill calls **both** `whoami` and `echo` through the existing Entra-protected MCP server.

The Microsoft 365 app package uses manifest **v1.29**, one `agentSkills` entry, and one remote `agentConnectors` entry with `OAuthPluginVault`. Cowork discovers tools dynamically; no static tool catalog is required.

**The checked-in package and release ZIPs are configuration templates, not install-ready apps.** Configure a real HTTPS endpoint, OAuth registration reference, and developer details before installation. No server, OAuth credentials, or tenant deployment is included.

## Prerequisites

- An eligible Microsoft 365 work tenant with **Copilot Cowork** available and permission to install custom apps/plugins. Tenant policies, admin approval, licensing, and rollout availability can prevent installation. This package does not enable Cowork.
- An externally reachable HTTPS deployment of [the server](../server/docs/azure-deployment.md), using TLS 1.2+ and a valid delegated API scope.
- Permission to configure an Entra calling client, grant the necessary consent, and register OAuth credentials in the Microsoft Enterprise token store.
- Node.js **24+** and npm for packaging from source. For a downloaded ZIP, standard ZIP tools suffice after editing its manifest.

Follow Microsoft's [Cowork plugin guide](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development) for current availability, tenant restrictions, and installation behavior. Custom plugins are not supported on Cowork mobile. Purview Information Barriers can block plugin/skill uploads.

## 1. Prepare the server

Follow [server setup](../server/README.md) first. Run all server npm, Docker, and azd commands from **`server/`**, not this folder.

For an Azure deployment, retrieve the endpoint from your selected environment:

```bash
cd server
azd env get-value MCP_ENDPOINT
azd env get-value ENTRA_TENANT_ID
azd env get-value ENTRA_AUDIENCE
```

These commands assume you start at the repository root. `MCP_ENDPOINT` includes `/mcp`; it must be an HTTPS URL accessible to Microsoft 365. `PUBLIC_BASE_URL` must match the external base URL. For a local demo, use a public HTTPS tunnel and configure that external base URL; localhost alone is not reachable from Cowork.

Use the API's actual **full exposed scope**, normally `api://<api-app-id>/mcp.invoke`. Do not infer it by blindly appending to an audience list: the server supports multiple audiences, and custom Application ID URIs are possible. Its current metadata has a [documented scope-format limitation](../server/docs/operations.md#oauth-client-integration); explicitly configure the OAuth endpoints and full scope below.

Keep issuer, audience, and delegated-scope enforcement unchanged. A Graph token, ID token, or app-only token is not a substitute for this API's delegated access token.

## 2. Configure a dedicated Copilot OAuth client

This is a **manual** setup. The server's existing Bicep/public desktop client remains unchanged. Create a separate Web client for this walkthrough; do not put a secret on the API registration or reuse the desktop client's loopback callback.

1. In the API's Entra tenant, register a calling application for the Cowork demo. Keep the API single-tenant; this guide does not make it a multi-tenant service.
2. Add a **Web** platform with this callback:

   ```text
   https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect
   ```

3. Add the API's **delegated** `mcp.invoke` permission (or your configured scope), and arrange user/admin consent as required by tenant policy.
4. Create a client secret for this Web client. Enter it only into the OAuth registration's secure credential field below. Do not write it into source, `.env`, the ZIP, release variables, screenshots, or skill text. Manage its expiry and rotate it in the vault.
5. Open the [Teams developer portal OAuth client registration](https://dev.teams.microsoft.com/tools), then **Tools > OAuth client registration > New OAuth client registration** (or **Register client**).
6. Configure the values below, save, and record the resulting **OAuth client registration ID** (auth config ID).

| OAuth registration field | Value |
| --- | --- |
| Registration name | A recognizable demo name |
| Base URL | The actual MCP endpoint, matching the connector URL; follow the portal's current URL-matching requirements |
| Client ID / secret | The dedicated Entra Web client's ID and secret |
| Authorization endpoint | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
| Token endpoint | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
| Refresh endpoint | Same token endpoint |
| Scope | `api://<api-app-id>/mcp.invoke offline_access` (substitute the actual full API scope) |
| PKCE | Leave enabled |
| Restrict usage by app | **Any Teams app**; Microsoft's MCP guidance warns that binding to an existing Teams app ID can cause runtime 404s |
| Restrict usage by org | The current Cowork guide requires **Any Microsoft 365 organization** for its connector registration; this does not change the API's single-tenant token validation |

Only the resulting **auth config ID** goes into `authorization.referenceId`. It is **not** the Entra client ID, API application ID, or Microsoft 365 manifest GUID. Credentials stay in Microsoft's token store.

See the official [Cowork connector authentication](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development#supported-auth-types) and [OAuth setup](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth) guides. Microsoft Entra does not support the dynamic-client-registration path here. A manifest without the required OAuth configuration will not make this server anonymous.

## 3. Customize the manifest

Edit `plugin/appPackage/manifest.json`, or the root `manifest.json` after extracting a release ZIP:

| Field | Replace with |
| --- | --- |
| `agentConnectors[0].toolSource.remoteMcpServer.mcpServerUrl` | Your HTTPS endpoint ending in `/mcp`, without query parameters, fragment, or embedded credentials |
| `agentConnectors[0].toolSource.remoteMcpServer.authorization.referenceId` | Your token-vault OAuth registration ID |
| `developer.name` | Your developer/publisher name |
| `developer.websiteUrl` | Your project website (the repository URL is the demo default) |
| `developer.privacyUrl` | Your real privacy information URL, replacing `example.com` |
| `developer.termsOfUseUrl` | Your real terms URL, replacing `example.com` |

For an independent tenant app, generate your own `id` GUID and retain it across updates; do not generate a new ID on every package build. The repository's template GUID is stable. Increment `version` when updating an installed app, or use the packaging `--version` flag. Keep skill folder/name and connector ID unchanged unless you also update the skill and validator.

The icons are original, simple demo assets. There are no production legal policies or public-store certification claims in this repository. Configure appropriate metadata before sharing your app.

## 4. Package

### From source

From the repository root:

```bash
cd plugin
npm ci
npm test
npm run package -- --configured
```

Configured mode refuses the documented endpoint, OAuth-reference, and developer placeholders. It creates `build/entra-mcp-cowork-plugin-configured-1.0.0.zip` with the manifest, icons, and single skill directly at ZIP root. To bump the packaged version without rewriting the source manifest:

```bash
npm run package -- --configured --version 1.0.1
```

To intentionally build an unconfigured template instead:

```bash
npm run package
npm run package -- --tag releases/plugin/v1.2.3
```

These produce `build/entra-mcp-cowork-plugin-template-<version>.zip`. The same packaging entry point is used in CI. It validates against the [pinned official schema](schema/README.md), skill/connector shape, icon dimensions, and a strict four-file allow-list. It does not contact Microsoft 365, Entra, or the server. Configured mode is a placeholder check, **not proof that authentication works**.

### From a downloaded release

Extract the template, edit its `manifest.json` as above, and create a new ZIP containing only these paths:

```text
manifest.json
color.png
outline.png
skills/entra-mcp-demo/SKILL.md
```

For Bash with `unzip` and `zip`, from the directory containing the download:

```bash
unzip entra-mcp-cowork-plugin-template-1.2.3.zip -d configured-plugin
cd configured-plugin
# Edit manifest.json before proceeding.
zip -r ../entra-mcp-cowork-plugin-configured-1.2.3.zip manifest.json color.png outline.png skills
```

PowerShell:

```powershell
Expand-Archive ./entra-mcp-cowork-plugin-template-1.2.3.zip ./configured-plugin
Set-Location ./configured-plugin
# Edit manifest.json before proceeding.
Compress-Archive -Path manifest.json,color.png,outline.png,skills -DestinationPath ../entra-mcp-cowork-plugin-configured-1.2.3.zip
```

Use a new destination ZIP to avoid retaining obsolete entries. Do not ZIP the containing directory or add OAuth credentials. To run the repository's offline validator on a customized download, copy those four files into a source checkout's `plugin/appPackage/` (preserving the skill subfolder) and use the source packaging command.

## 5. Install and try it

Use the [current Microsoft installation instructions](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development#step-7-test). For example, with Microsoft 365 Agents Toolkit CLI installed and signed into the intended work tenant:

```bash
atk auth login
atk install --file-path ./build/entra-mcp-cowork-plugin-configured-1.0.0.zip --scope Personal
```

Run this from `plugin/` for a source build; substitute your actual configured ZIP path for a download. Save the returned TitleId/AppId to manage updates or removal. Tenant policy may require an administrator to upload/approve the app instead. Admin-center upload can list it in **Cowork > Sources & Skills > Plugins > Discover**; targeted sharing uses the separate supported sharing flow.

Enable the plugin in Cowork, complete the connector's sign-in/consent, and try:

```text
Run the Entra MCP demo and echo "hello from my plugin".
```

The single skill calls `whoami` with `{}`, then `echo` with your message. It reports the returned identity and the exact echo text (`<subject>: hello from my plugin`). Without an explicit message, it uses `Hello from Microsoft 365 Copilot`. Messages must have 1-4000 characters; over-length input is reported, not truncated.

**Manual end-to-end check:** confirm both tool calls actually ran, the identity matches the consenting account, and the echo includes your message. Disconnect/sign out and verify the host requests authentication again. Do not treat offline tests, a successful upload, or `/healthz` as evidence of a working authenticated Cowork integration. Identity results can contain personal data; do not publish them.

| Symptom | Check |
| --- | --- |
| Plugin cannot upload | Cowork availability, custom-app policy, manifest version, required icons, and unreplaced metadata |
| Connector is missing | Plugin enabled in Cowork, configured HTTPS URL, tenant approval; not Copilot Chat or mobile |
| Sign-in/consent fails | Web callback, client secret expiry, API delegated permission, actual full scope, and administrator consent |
| Runtime 404 | Endpoint and OAuth base-URL matching; vault usage restriction must not bind to a specific Teams app ID |
| 401 | Token issued for this API and tenant, not Graph; server audience and issuer; no raw tokens in prompts |
| 403 | Access token's `scp` must include the configured delegated scope |
| Tokens stop refreshing | Include `offline_access`, verify token/refresh endpoint, and rotate expired Web-client credentials |
| First call times out | The server may be waking from Azure scale-to-zero; warm it and retry after startup |

## Releases

From the repository root, after committing the desired files:

```bash
git tag releases/plugin/v1.2.3
git push origin releases/plugin/v1.2.3
```

[The workflow](../.github/workflows/release-plugin.yml) accepts only canonical `releases/plugin/vX.Y.Z` tags (no leading zeros, prereleases, or build suffixes). It runs plugin tests and validation, stamps `1.2.3` into the packaged manifest **in memory**, and publishes `entra-mcp-cowork-plugin-template-1.2.3.zip` in a GitHub Release for that tag. It does not edit the checked-in template, plugin package metadata, or server version.

Publishing uses the built-in GitHub token with `contents: write` only in the release job. No Azure/Entra secrets or deployment-specific repository variables are needed. GitHub Actions must be allowed to create repository releases. An existing release causes publication to fail rather than silently replacing its assets.

The result remains a **configuration template**. This workflow does not deploy Azure resources, register OAuth clients, install into a tenant, or submit to the Microsoft 365 store.
