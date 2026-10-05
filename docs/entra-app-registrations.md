# Entra app registrations

[Project overview](../README.md) | [Local development](local-development.md) | [Azure deployment](azure-deployment.md)

Use this guide for local development and Azure deployments with `CREATE_ENTRA_APP_REGISTRATIONS=false`. With `true`, [azd creates the registrations](azure-deployment.md#create_entra_app_registrationstrue) instead; do not create an extra pair first.

## Understand the values

| Value | Meaning and destination |
| --- | --- |
| Directory (tenant) ID | `ENTRA_TENANT_ID` on the server |
| API Application (client) ID | `ENTRA_AUDIENCE` on the server: a bare GUID for Entra v2 access tokens |
| API Application ID URI | Identifies the exposed API; normally `api://<api-app-id>` |
| Delegated scope name | `MCP_REQUIRED_SCOPE`, normally `mcp.invoke` |
| Requested scope | Application ID URI plus scope name: `api://<api-app-id>/mcp.invoke` |
| Calling client's Application (client) ID | Client OAuth configuration; use `MCP_CLIENT_ID` in the examples, not as a server setting |
| Application/service-principal object ID | Graph directory object identifier used for administration and permanent purge, not a token audience |

For the default v2 setup, a valid access token has `aud=<api-app-id>`, `iss=https://login.microsoftonline.com/<tenant-id>/v2.0`, and `scp` containing `mcp.invoke`. Requesting `api://<api-app-id>/mcp.invoke` does **not** make the audience `api://<api-app-id>`.

The server accepts comma-separated exact audience values if deliberately needed, but do not add unrelated audiences to work around a bad token. Microsoft Graph tokens target another API and will be rejected.

## Permissions and client choices

An Entra tenant is required for both local and remote use. Registration rights depend on tenant policy. The scripts below also create service principals and grant tenant-wide delegated consent, requiring appropriate directory privileges, such as Application Administrator or Cloud Application Administrator where allowed. Some consent operations require a higher role or another administrator. An Azure subscription Owner role does not itself grant Entra directory permissions.

The API only validates tokens: it needs **no secret or certificate**. A desktop/CLI **public client** uses Authorization Code + PKCE without a secret. Configure the redirect URI to match your actual OAuth client's callback; the example `http://localhost:3000/callback` is a placeholder. This MCP server does not implement `/callback`; use a separate callback listener/port if your client needs one.

For a browser client, register a **Single-page application** platform with its actual callback URI instead of the desktop platform. The scripts and Bicep module configure the desktop/CLI case only. Client implementation and browser CORS requirements are outside this server's setup.

## Manual portal setup

### API registration

1. In the [Entra admin center](https://entra.microsoft.com), open **App registrations > New registration**. Name it `simple-mcp-server-api` and select **Accounts in this organizational directory only**.
2. Save its **Application (client) ID** and **Directory (tenant) ID**.
3. In **Manifest**, set `api.requestedAccessTokenVersion` to `2` and save. The API controls its access-token version; using a v2 authorization endpoint alone is not sufficient.
4. In **Expose an API**, set the **Application ID URI** to `api://<api-app-id>` (or a supported custom URI).
5. Add an enabled scope named `mcp.invoke`, with consent display names/descriptions such as "Invoke MCP tools". Choose **Admins and users**, or admins only according to tenant policy. Record the full requested scope.

### Calling-client registration

1. Create a second single-tenant registration named `simple-mcp-server-client`. Save its Application (client) ID separately from the API ID.
2. In **Authentication > Add a platform**, choose **Mobile and desktop applications** and register the client's actual loopback callback URI. Enable **Allow public client flows** for this public-client setup. Use the SPA platform instead for a browser client.
3. In **API permissions > Add a permission > My APIs**, select the API registration, choose **Delegated permissions**, and add `mcp.invoke`.
4. Grant admin consent where required by your tenant policy, or arrange consent with an authorized administrator.

Application registrations and enterprise applications (service principals) are distinct. Consent establishes the delegated permission grant between service principals. The scripted setup below creates them explicitly.

## Scripted setup

Choose **one** of these equivalent scripts and run it from the repository root or another working directory. Sign in first with `az login --tenant "<tenant-id>"`. Edit display names, redirect URI, and scope before running.

These are creation scripts, **not idempotent upserts**. Rerunning creates another pair with new IDs. If a command fails, stop, inspect the objects already created, and either complete setup deliberately or [clean up that exact pair](operations.md#independently-managed-registrations). Do not assume a failed script rolled back its changes.

### Bash

Requires Bash and `uuidgen`. Run in a dedicated Bash process; `set -e` stops it on command failure.

```bash
set -euo pipefail

apiDisplayName="simple-mcp-server-api"
clientDisplayName="simple-mcp-server-client"
redirectUri="http://localhost:3000/callback"
scopeName="mcp.invoke"
tenantId=$(az account show --query tenantId -o tsv)

apiAppId=$(az ad app create --display-name "$apiDisplayName" --sign-in-audience AzureADMyOrg --query appId -o tsv)
printf 'Created API app: %s\n' "$apiAppId"
apiObjectId=$(az ad app show --id "$apiAppId" --query id -o tsv)
az ad sp create --id "$apiAppId" >/dev/null
scopeId=$(uuidgen)
identifierUri="api://$apiAppId"

apiPatch=$(cat <<JSON
{
  "identifierUris": ["$identifierUri"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{
      "id": "$scopeId", "value": "$scopeName", "type": "User", "isEnabled": true,
      "adminConsentDisplayName": "Invoke MCP tools",
      "adminConsentDescription": "Invoke MCP tools on behalf of the signed-in user.",
      "userConsentDisplayName": "Invoke MCP tools",
      "userConsentDescription": "Invoke MCP tools on your behalf."
    }]
  }
}
JSON
)
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObjectId" --body "$apiPatch"

clientAppId=$(az ad app create --display-name "$clientDisplayName" \
  --sign-in-audience AzureADMyOrg --public-client-redirect-uris "$redirectUri" \
  --is-fallback-public-client true --query appId -o tsv)
printf 'Created client app: %s\n' "$clientAppId"
az ad sp create --id "$clientAppId" >/dev/null
az ad app permission add --id "$clientAppId" --api "$apiAppId" --api-permissions "$scopeId=Scope"
az ad app permission admin-consent --id "$clientAppId"

printf '%s\n' "ENTRA_TENANT_ID=$tenantId" "ENTRA_AUDIENCE=$apiAppId" \
  "MCP_REQUIRED_SCOPE=$scopeName" "MCP_CLIENT_ID=$clientAppId" \
  "REQUESTED_SCOPE=$identifierUri/$scopeName"
```

### PowerShell

Use PowerShell 7+. The wrapper checks native Azure CLI exit codes: `$ErrorActionPreference` alone does not make all native command failures terminating. A temporary JSON file avoids native JSON-argument quoting differences.

```powershell
$ErrorActionPreference = "Stop"
function Invoke-Az {
    $output = & az @args
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($args -join ' ')" }
    return $output
}

$apiDisplayName = "simple-mcp-server-api"
$clientDisplayName = "simple-mcp-server-client"
$redirectUri = "http://localhost:3000/callback"
$scopeName = "mcp.invoke"
$tenantId = Invoke-Az account show --query tenantId -o tsv

$apiAppId = Invoke-Az ad app create --display-name $apiDisplayName --sign-in-audience AzureADMyOrg --query appId -o tsv
Write-Host "Created API app: $apiAppId"
$apiObjectId = Invoke-Az ad app show --id $apiAppId --query id -o tsv
Invoke-Az ad sp create --id $apiAppId | Out-Null
$scopeId = [guid]::NewGuid().ToString()
$identifierUri = "api://$apiAppId"
$apiPatch = @{
    identifierUris = @($identifierUri)
    api = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes = @(@{
            id = $scopeId; value = $scopeName; type = "User"; isEnabled = $true
            adminConsentDisplayName = "Invoke MCP tools"
            adminConsentDescription = "Invoke MCP tools on behalf of the signed-in user."
            userConsentDisplayName = "Invoke MCP tools"
            userConsentDescription = "Invoke MCP tools on your behalf."
        })
    }
} | ConvertTo-Json -Depth 10
$patchFile = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($patchFile, $apiPatch)
    Invoke-Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObjectId" --body "@$patchFile"
} finally {
    Remove-Item -LiteralPath $patchFile
}

$clientAppId = Invoke-Az ad app create --display-name $clientDisplayName `
    --sign-in-audience AzureADMyOrg --public-client-redirect-uris $redirectUri `
    --is-fallback-public-client true --query appId -o tsv
Write-Host "Created client app: $clientAppId"
Invoke-Az ad sp create --id $clientAppId | Out-Null
Invoke-Az ad app permission add --id $clientAppId --api $apiAppId --api-permissions "$scopeId=Scope"
Invoke-Az ad app permission admin-consent --id $clientAppId

Write-Host "ENTRA_TENANT_ID=$tenantId"
Write-Host "ENTRA_AUDIENCE=$apiAppId"
Write-Host "MCP_REQUIRED_SCOPE=$scopeName"
Write-Host "MCP_CLIENT_ID=$clientAppId"
Write-Host "REQUESTED_SCOPE=$identifierUri/$scopeName"
```

Allow time for directory changes to propagate before consent or token acquisition; investigate failures rather than creating duplicate apps. The printed values are non-secret configuration, but access tokens must not be saved or shared.

## Optional Azure CLI authorization for smoke tests

`az account get-access-token` uses the **Azure CLI's client registration**, not the public client you just created. Granting permissions to your client does not grant them to Azure CLI.

If your tenant permits it, open the API registration's **Expose an API > Authorized client applications**, add the Azure CLI application ID `04b07795-8ddb-461a-bbee-02f9e1bf7b46`, and select the exposed scope. This preauthorizes Azure CLI for that scope; it is a deliberate trust/consent choice, not a server setting. Tenant policy may still restrict the flow. The `azd` creation path does this by default unless `ENTRA_AUTHORIZE_AZURE_CLI_CLIENT=false`.

If Azure CLI is not permitted, use your actual client's Authorization Code + PKCE flow to acquire the API token. Request the full exposed scope; add `offline_access` only if your client needs refresh tokens. Never use a Graph token as a substitute.

## Apply the values

For local use, follow [local development](local-development.md) and put server values in `.env`. Keep the client ID and requested scope in your OAuth client's configuration.

For Azure, follow the [false registration-creation path](azure-deployment.md#create_entra_app_registrationsfalse-default) and set `azd` environment values explicitly. Copying the local `.env` does not configure the Azure deployment.
