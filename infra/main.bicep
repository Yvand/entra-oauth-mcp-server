targetScope = 'subscription'

@minLength(1)
@maxLength(32)
@description('Name of the azd environment. Used to name and tag all resources.')
param environmentName string

@minLength(1)
@description('Azure region for all resources.')
param location string

@description('Microsoft Entra directory (tenant) ID used to validate access tokens. Placeholder by default — replace before the server can accept real traffic.')
param entraTenantId string = '00000000-0000-0000-0000-000000000000'

@description('Expected "aud" claim of incoming access tokens, e.g. api://<api-client-id>. Comma-separated list allowed. Placeholder by default.')
param entraAudience string = 'api://00000000-0000-0000-0000-000000000000'

@description('Delegated scope a caller must hold to invoke MCP tools.')
param mcpRequiredScope string = 'mcp.invoke'

@description('Optional override for the OAuth issuer. Empty means the app derives it from the tenant ID.')
param entraIssuer string = ''

@description('Optional override for the JWKS URI. Empty means the app derives it from the tenant ID.')
param entraJwksUri string = ''

@description('Optional public base URL (e.g. a custom domain). Empty means it is derived from the Container Apps ingress FQDN.')
param publicBaseUrl string = ''

@description('Container port the app listens on. Must match the PORT env var.')
param containerPort int = 3000

@minValue(0)
@description('Minimum replica count. 0 enables scale-to-zero.')
param minReplicas int = 0

@minValue(1)
@description('Maximum replica count.')
param maxReplicas int = 3

@minValue(30)
@maxValue(730)
@description('Log Analytics retention in days. 30 is the lowest retention billed at no extra charge.')
param logAnalyticsRetentionInDays int = 30

@description('Daily ingestion cap for Log Analytics, in GB. Guards against unexpected cost.')
param logAnalyticsDailyQuotaGb int = 1

@description('Set by azd. True when the container app already exists, so the current image is preserved across provisions.')
param mcpExists bool = false

var abbrs = {
  resourceGroup: 'rg'
  containerRegistry: 'cr'
  containerAppsEnvironment: 'cae'
  containerApp: 'ca'
  logAnalytics: 'log'
}

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = {
  'azd-env-name': environmentName
}

var serviceName = 'mcp'
var resourceGroupName = '${abbrs.resourceGroup}-${environmentName}'
var containerAppName = '${abbrs.containerApp}-${serviceName}-${resourceToken}'

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module logAnalytics 'br/public:avm/res/operational-insights/workspace:0.16.1' = {
  name: 'log-${resourceToken}'
  scope: rg
  params: {
    name: '${abbrs.logAnalytics}-${resourceToken}'
    location: location
    tags: tags
    skuName: 'PerGB2018'
    dataRetention: logAnalyticsRetentionInDays
    dailyQuotaGb: string(logAnalyticsDailyQuotaGb)
  }
}

module containerRegistry 'br/public:avm/res/container-registry/registry:0.13.0' = {
  name: 'cr-${resourceToken}'
  scope: rg
  params: {
    name: '${abbrs.containerRegistry}${resourceToken}'
    location: location
    tags: tags
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    // Basic SKU cannot carry a networkRuleSet (virtual network / IP rules) at all —
    // ACR rejects it with NetworkRuleNotSupported. The module only omits that
    // property when networkRuleSetDefaultAction is 'Allow'; its own default is
    // 'Deny', which combined with publicNetworkAccess: 'Enabled' makes it emit
    // networkRuleSet unconditionally. Basic has no way to restrict network access
    // anyway, so 'Allow' here has no effect beyond suppressing that property.
    networkRuleSetDefaultAction: 'Allow'
  }
}

module containerAppsEnvironment 'br/public:avm/res/app/managed-environment:0.16.0' = {
  name: 'cae-${resourceToken}'
  scope: rg
  params: {
    name: '${abbrs.containerAppsEnvironment}-${resourceToken}'
    location: location
    tags: tags
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsWorkspaceResourceId: logAnalytics.outputs.resourceId
    }
    // The module defaults zoneRedundant to true, which Azure rejects unless the
    // environment is deployed into a subnet (infrastructureSubnetResourceId). This
    // deployment has no VNet, so zone redundancy must be explicitly disabled.
    zoneRedundant: false
  }
}

// The ingress FQDN is deterministic once the environment exists:
// <app-name>.<environment default domain>. This resolves the PUBLIC_BASE_URL
// chicken-and-egg problem without needing a second deployment pass.
var derivedBaseUrl = 'https://${containerAppName}.${containerAppsEnvironment.outputs.defaultDomain}'
var effectiveBaseUrl = empty(publicBaseUrl) ? derivedBaseUrl : publicBaseUrl

// On the very first provision no image has been pushed yet, so a public
// placeholder is used; `azd deploy` replaces it immediately afterwards.
module fetchLatestImage 'modules/fetch-container-image.bicep' = {
  name: 'fetch-image-${serviceName}'
  scope: rg
  params: {
    exists: mcpExists
    name: containerAppName
  }
}

var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var containerImage = mcpExists ? fetchLatestImage.outputs.containerImage : placeholderImage

module containerApp 'br/public:avm/res/app/container-app:0.23.0' = {
  name: 'ca-${serviceName}-${resourceToken}'
  scope: rg
  params: {
    name: containerAppName
    location: location
    tags: union(tags, {
      'azd-service-name': serviceName
    })
    environmentResourceId: containerAppsEnvironment.outputs.resourceId
    managedIdentities: {
      systemAssigned: true
    }
    ingressExternal: true
    ingressAllowInsecure: false
    ingressTargetPort: containerPort
    ingressTransport: 'auto'
    scaleSettings: {
      minReplicas: minReplicas
      maxReplicas: maxReplicas
      rules: [
        {
          name: 'http-scale'
          http: {
            metadata: {
              concurrentRequests: '50'
            }
          }
        }
      ]
    }
    registries: [
      {
        server: containerRegistry.outputs.loginServer
        identity: 'system'
      }
    ]
    containers: [
      {
        name: serviceName
        image: containerImage
        resources: {
          cpu: json('0.5')
          memory: '1Gi'
        }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'PORT', value: string(containerPort) }
          // Required: the app defaults to 127.0.0.1 and would accept no external traffic.
          { name: 'HOST', value: '0.0.0.0' }
          { name: 'ENTRA_TENANT_ID', value: entraTenantId }
          { name: 'ENTRA_AUDIENCE', value: entraAudience }
          { name: 'MCP_REQUIRED_SCOPE', value: mcpRequiredScope }
          { name: 'ENTRA_ISSUER', value: entraIssuer }
          { name: 'ENTRA_JWKS_URI', value: entraJwksUri }
          { name: 'PUBLIC_BASE_URL', value: effectiveBaseUrl }
        ]
        // Custom probes target /healthz, which only the real image serves.
        // They are omitted on the first provision, while the placeholder runs.
        probes: mcpExists ? [
          {
            type: 'Liveness'
            httpGet: {
              path: '/healthz'
              port: containerPort
            }
            initialDelaySeconds: 5
            periodSeconds: 30
            failureThreshold: 3
          }
          {
            type: 'Readiness'
            httpGet: {
              path: '/healthz'
              port: containerPort
            }
            initialDelaySeconds: 3
            periodSeconds: 10
            failureThreshold: 3
          }
        ] : []
      }
    ]
  }
}

// Separate module so the role assignment can consume the container app's principal ID
// without creating a circular dependency between the app and the registry.
module acrPullRole 'modules/acr-pull-role.bicep' = {
  name: 'acr-pull-${resourceToken}'
  scope: rg
  params: {
    registryName: containerRegistry.outputs.name
    principalId: containerApp.outputs.systemAssignedMIPrincipalId!
  }
}

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = resourceGroupName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.outputs.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistry.outputs.name
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = containerAppsEnvironment.outputs.name
output SERVICE_MCP_NAME string = containerApp.outputs.name
output SERVICE_MCP_URI string = effectiveBaseUrl
output MCP_ENDPOINT string = '${effectiveBaseUrl}/mcp'
output MCP_PROTECTED_RESOURCE_METADATA string = '${effectiveBaseUrl}/.well-known/oauth-protected-resource'
