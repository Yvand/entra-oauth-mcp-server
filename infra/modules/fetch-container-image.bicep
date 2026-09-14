@description('Name of the container app to inspect.')
param name string

@description('Whether the container app already exists. False on the first provision.')
param exists bool

resource existingApp 'Microsoft.App/containerApps@2024-03-01' existing = if (exists) {
  name: name
}

output containerImage string = exists ? existingApp!.properties.template.containers[0].image : ''
