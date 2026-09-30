targetScope = 'subscription'

// Creates and configures the two Microsoft Entra ID app registrations documented in
// README.md section 1: the API (this server) and the PKCE desktop/CLI client. This is a
// Bicep equivalent of the portal steps in 1a-1b / the CLI scripts in "CLI alternative to
// 1a-1b", using the Microsoft Graph Bicep extension instead of `az ad app` commands.
//
// This file is a module invoked from infra/main.bicep (guarded by the
// createEntraAppRegistrations parameter), so it deploys as part of the normal `azd
// provision` / `azd up` flow — no separate `az` invocation needed. It requires no
// resource group: Microsoft Graph objects aren't Azure resources.
//
// Requires the azd/az principal to be allowed to create app registrations and grant
// tenant-wide admin consent (e.g. Application Administrator / Cloud Application
// Administrator — some tenants require a higher-privileged role for admin consent).

extension microsoftGraphV1

@description('Display name for the API app registration (this server).')
param apiDisplayName string = 'simple-mcp-server-api'

@description('Display name for the public-client (desktop/CLI, PKCE) app registration.')
param clientDisplayName string = 'simple-mcp-server-client'

@description('Redirect URI registered on the public client for the Authorization Code + PKCE flow.')
param redirectUri string = 'http://localhost:3000/callback'

@description('Delegated scope name exposed by the API and required by the server (MCP_REQUIRED_SCOPE).')
param scopeName string = 'mcp.invoke'

@description('Optional custom Application ID URI used to request the API scope, e.g. api://contoso-mcp-api. This does not change the bare API app ID in the "aud" claim of v2 access tokens.')
param apiIdentifierUri string = ''

@description('Grant tenant-wide admin consent for the client to call the API scope. Requires a privileged role; set to false to consent manually afterward.')
param grantAdminConsent bool = true

var scopeId = guid(subscription().id, apiDisplayName, scopeName)

resource apiApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: apiDisplayName
  displayName: apiDisplayName
  signInAudience: 'AzureADMyOrg'
  identifierUris: empty(apiIdentifierUri) ? [] : [apiIdentifierUri]
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: scopeId
        value: scopeName
        type: 'User'
        isEnabled: true
        adminConsentDisplayName: 'Invoke MCP tools'
        adminConsentDescription: 'Allows the app to invoke MCP tools on behalf of the signed-in user.'
        userConsentDisplayName: 'Invoke MCP tools'
        userConsentDescription: 'Allows the app to invoke MCP tools on your behalf.'
      }
    ]
  }
}

// No client secret or certificate: this server only validates tokens, it never requests them.
resource apiServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: apiApp.appId
}

resource clientApp 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: clientDisplayName
  displayName: clientDisplayName
  signInAudience: 'AzureADMyOrg'
  // Public client (Authorization Code + PKCE, no secret), matching README's "Mobile and
  // desktop applications" platform. SPA registrations still need the portal steps in 1b.
  isFallbackPublicClient: true
  publicClient: {
    redirectUris: [redirectUri]
  }
  requiredResourceAccess: [
    {
      resourceAppId: apiApp.appId
      resourceAccess: [
        {
          id: scopeId
          type: 'Scope'
        }
      ]
    }
  ]
}

resource clientServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: clientApp.appId
}

// Delegated permission grant + admin consent, equivalent to `az ad app permission add` +
// `az ad app permission admin-consent` in the CLI scripts. Runs even though the scope type
// is `User`, so setup also works in tenants that restrict user self-consent.
resource adminConsentGrant 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = if (grantAdminConsent) {
  clientId: clientServicePrincipal.id
  consentType: 'AllPrincipals'
  resourceId: apiServicePrincipal.id
  scope: scopeName
}

output ENTRA_TENANT_ID string = tenant().tenantId
output API_APP_ID string = apiApp.appId
output CLIENT_APP_ID string = clientApp.appId
output ENTRA_AUDIENCE string = apiApp.appId
output MCP_REQUIRED_SCOPE string = scopeName
output REQUESTED_SCOPE string = '${empty(apiIdentifierUri) ? apiApp.appId : apiIdentifierUri}/${scopeName}'
