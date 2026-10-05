# Azure deployment with azd

[Project overview](../README.md) | [App registrations](entra-app-registrations.md) | [Testing](testing.md) | [Operations and cleanup](operations.md)

Use the **Azure Developer CLI (`azd`)** to provision and deploy the server to Azure Container Apps. Choose whether `azd` should own the Entra registrations **before** provisioning.

| `CREATE_ENTRA_APP_REGISTRATIONS` | Registration source | Server tenant/audience | Registration cleanup |
| --- | --- | --- | --- |
| `true` | Microsoft Graph Bicep module creates an environment-specific API/client pair | Derived automatically from created API | Ownership-checked `postdown` deletion and permanent purge, unless opted out |
| `false` (default) | Existing apps, created manually or with scripts | Set explicitly with `azd env set` | Yours to manage; `azd down` does not delete them |

Azure resources and Entra directory objects have different lifecycles. Read [cleanup](operations.md#azure-teardown) before choosing automatic ownership, particularly if you plan to share registrations with another deployment.

## Prerequisites and architecture

- Install [azd](https://aka.ms/azd-install) and use an Azure subscription with permission to provision resources at subscription/resource-group scope and create role assignments. Contributor alone cannot create role assignments; use an appropriately authorized deployment identity.
- Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) for scripted registrations, token checks, and the Entra cleanup hook. Its sign-in is separate from `azd auth login`.
- When creating registrations through `azd`, the deploying identity also needs [Entra registration and consent permissions](entra-app-registrations.md#permissions-and-client-choices). Subscription RBAC does not grant these.
- POSIX cleanup needs Bash; Windows cleanup uses PowerShell (`pwsh`).

[azure.yaml](../azure.yaml) sets `docker.remoteBuild: true`: the Dockerfile is built remotely in ACR. Local Docker is not required for successful remote builds; Docker/Podman can provide a local fallback if available, or Docker can be used for intentional local builds. See the official [azd Docker schema](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/azd-schema#docker). Node.js/npm are needed if you also develop or run tests locally; the Dockerfile installs/builds the application in the remote build.

| Resource | Configuration |
| --- | --- |
| Resource group | Named `rg-<azd-environment>` |
| Container App | HTTPS external ingress; 0.5 vCPU/1 GiB; min 0/max 3 replicas |
| Container Apps environment | Consumption hosting |
| Container Registry | Basic; admin credentials disabled |
| Log Analytics workspace | PerGB2018; 30-day retention; 1 GB/day ingestion cap |
| User-assigned managed identity | Registry-scoped `AcrPull` for the Container App |

No database, Key Vault, or Application Insights is deployed. Scale-to-zero reduces idle compute usage but does not remove registry/logging charges or guarantee a zero-cost deployment. Cold starts are expected.

## 1. Authenticate and choose an environment

Run from the repository root. These `azd` commands work in Bash and PowerShell:

```bash
azd auth login --tenant-id "<tenant-id>"
az login --tenant "<tenant-id>"
azd env new mcp-dev
azd env set AZURE_SUBSCRIPTION_ID "<subscription-id>"
azd env set AZURE_LOCATION "<azure-region>"
```

Choose the tenant associated with the subscription. The `true` path creates registrations in that deployment tenant. With `false`, explicitly configure the token-issuing tenant.

For an existing environment, use `azd env select mcp-dev` instead of `azd env new`. Check the selection with `azd env list`. Environment names are used by Bicep naming and Entra ownership; do not rename one and assume its old objects move with it.

Choose **one** of the following paths.

## CREATE_ENTRA_APP_REGISTRATIONS=true

Let `azd` create and configure the two registrations as part of provisioning:

```bash
azd env set CREATE_ENTRA_APP_REGISTRATIONS true
azd env set MCP_REQUIRED_SCOPE mcp.invoke

# Optional overrides; these show the defaults.
azd env set ENTRA_API_DISPLAY_NAME simple-mcp-server-api
azd env set ENTRA_CLIENT_DISPLAY_NAME simple-mcp-server-client
azd env set ENTRA_CLIENT_REDIRECT_URI http://localhost:3000/callback
azd env set ENTRA_AUTHORIZE_AZURE_CLI_CLIENT true
azd env set ENTRA_AZURE_CLI_APP_ID 04b07795-8ddb-461a-bbee-02f9e1bf7b46

azd up
```

Set the redirect URI to your **client's callback**, not automatically to the deployed API URL. The default is only an example; the server has no callback route. The module configures a single-tenant public desktop/CLI client for Authorization Code + PKCE, not an SPA.

The module creates API/client applications and service principals, exposes the configured delegated scope, grants tenant-wide admin consent, and preauthorizes the created client. It also preauthorizes Azure CLI by default; set `ENTRA_AUTHORIZE_AZURE_CLI_CLIENT=false` before provisioning if that trust is not desired.

The API requests v2 access tokens and uses `api://<api-app-id>` as its Application ID URI. Container `ENTRA_TENANT_ID` and `ENTRA_AUDIENCE` are derived from the created API, overriding supplied tenant/audience inputs in this path. You do not need to enter them manually.

The registrations' Graph `uniqueName` and ownership tags are scoped to the subscription and environment, allowing repeated provisions to target the same objects. Display names alone do not identify ownership and can be identical across environments.

After deployment, retrieve `ENTRA_API_APP_ID` and `ENTRA_CLIENT_APP_ID` as described under [outputs](#3-retrieve-outputs-and-configure-your-client). Keep the client ID in your OAuth client's configuration.

## CREATE_ENTRA_APP_REGISTRATIONS=false (default)

Create or reuse registrations **before** deployment using either [manual portal setup](entra-app-registrations.md#manual-portal-setup) or [Bash/PowerShell scripts](entra-app-registrations.md#scripted-setup). Both methods must expose the delegated scope and configure the calling client.

Copy their values explicitly into the selected `azd` environment:

```bash
azd env set CREATE_ENTRA_APP_REGISTRATIONS false
azd env set ENTRA_TENANT_ID "<directory-tenant-id>"
azd env set ENTRA_AUDIENCE "<api-application-client-id>"
azd env set MCP_REQUIRED_SCOPE mcp.invoke

# Client/test bookkeeping only; not a server or Bicep input.
azd env set MCP_CLIENT_ID "<calling-client-application-id>"

azd up
```

Set `ENTRA_AUDIENCE` to the **bare API application ID** for Entra v2 tokens. Do not put the client's ID or requested scope here. `MCP_REQUIRED_SCOPE` is the short name; the client requests the full Application ID URI plus that name.

`MCP_CLIENT_ID` is an example convention for preserving your separately managed calling-client ID in the `azd` environment. The application and infrastructure do not read it; copy it into your real client's OAuth settings.

Do **not** use `ENTRA_CLIENT_APP_ID` as your manual configuration store: [main.bicep](../infra/main.bicep) emits empty `ENTRA_API_APP_ID`, `ENTRA_CLIENT_APP_ID`, and `ENTRA_APP_OWNERSHIP_TAG` outputs in `false` mode. There is no client-ID deployment parameter. Those empty outputs do not mean the externally managed registrations have been removed.

The tenant/audience parameter defaults are placeholder GUIDs to allow provisioning; they do not produce a usable protected API. Fill in real values before testing authentication. Editing the root `.env` is not a substitute for these `azd env set` commands.

## 2. Understand provisioning and deployment

`azd up` combines infrastructure provisioning with application packaging/deployment. ACR must exist for the remote image build; the Container App initially uses a public placeholder image until the real image is deployed. Its `/healthz` probes can briefly be unhealthy during this transition. Do not use a provision-only placeholder as proof that the MCP server is deployed.

The Bicep templates set `HOST=0.0.0.0`, `PORT=3000`, and derive `PUBLIC_BASE_URL` from the HTTPS ingress FQDN. For a custom domain, set `PUBLIC_BASE_URL` to the public base URL before re-provisioning; configuring the domain/TLS itself is a separate platform task.

## 3. Retrieve outputs and configure your client

```bash
azd env get-values
azd env get-value SERVICE_MCP_URI
azd env get-value MCP_ENDPOINT
```

Values are stored in the selected `.azure/<environment>/` state. `azd env set` does not export them into your terminal. Read individual values instead of executing the output as a shell script.

| Value | Source/use |
| --- | --- |
| `ENTRA_TENANT_ID`, `ENTRA_AUDIENCE` | Effective server tenant/audience outputs; inputs as well in `false` mode |
| `MCP_REQUIRED_SCOPE` | Deployment input; short scope name, default `mcp.invoke` |
| `ENTRA_API_APP_ID`, `ENTRA_CLIENT_APP_ID` | Generated registration outputs in `true` mode; empty in `false` mode |
| `MCP_CLIENT_ID` | Optional external-client bookkeeping in `false` mode; never read by the server |
| `ENTRA_APP_OWNERSHIP_TAG` | Generated cleanup ownership marker in `true` mode |
| `SERVICE_MCP_URI` | Public base URL, without `/mcp` |
| `MCP_ENDPOINT` | Full client endpoint including `/mcp` |
| `MCP_PROTECTED_RESOURCE_METADATA` | Full metadata URL |

Configure your actual OAuth client with its application ID, the tenant, its registered callback, the requested scope, and `MCP_ENDPOINT`. With the generated registration, the requested scope is `api://<ENTRA_API_APP_ID>/<MCP_REQUIRED_SCOPE>`; with a manual custom URI, use the URI you exposed instead.

Generated client ID (Bash / PowerShell):

```bash
MCP_CLIENT_ID=$(azd env get-value ENTRA_CLIENT_APP_ID) || exit 1
```

```powershell
$MCP_CLIENT_ID = azd env get-value ENTRA_CLIENT_APP_ID
if ($LASTEXITCODE -ne 0) { throw "Cannot read generated client ID" }
```

For `false`, retrieve `MCP_CLIENT_ID` instead. These terminal variables configure your test/client workflow; they do not change the deployed server. See [OAuth client caveats](operations.md#oauth-client-integration) before relying exclusively on metadata discovery.

## 4. Verify, update, and remove

Follow [live verification](testing.md#live-verification-local-or-azure) for health, metadata, and authenticated MCP requests. The offline suite does not contact this deployment.

For image/source changes:

```bash
azd deploy
```

For infrastructure-backed settings such as tenant, audience, required scope, or public URL:

```bash
azd env set ENTRA_AUDIENCE "<api-application-client-id>"
azd provision
azd deploy
```

Changing an `azd` environment value alone does not update the Container App. Re-provisioning preserves an existing image through the image lookup module; `azd deploy` refreshes the application image. `azd up` can also apply both phases.

Changing `CREATE_ENTRA_APP_REGISTRATIONS` is **not** a registration migration or deletion operation. Avoid toggling it on an existing deployment without planning identity changes and cleanup; switching to `false` disables the automatic cleanup gate.

For teardown, use [Azure cleanup instructions](operations.md#azure-teardown), including the irreversible Entra purge warning and opt-out, rather than assuming Azure resource deletion removes all directory objects.
