@description('Name of the existing Azure Container Registry.')
param registryName string

@description('Principal ID of the identity that needs to pull images.')
param principalId string

// AcrPull — lets the container app pull images using its managed identity,
// so the registry admin user can stay disabled.
var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      acrPullRoleDefinitionId
    )
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
