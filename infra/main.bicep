// =============================================================================
// Clio MCP — Azure infrastructure (Container Apps + ACR + Key Vault + Files)
// =============================================================================
//
// Resources provisioned:
//   - Log Analytics workspace
//   - Application Insights (workspace-based)
//   - Azure Container Registry (Basic) with anonymous pull disabled
//   - User-assigned managed identity (used by the Container App)
//   - Azure Key Vault (RBAC mode) with the identity granted "Key Vault Secrets User"
//   - Azure Storage Account + File Share for persistent state (token blob + audit log)
//   - Container Apps environment (with the file share registered as a storage)
//   - Container App pointing at the ACR image, with Key Vault secret refs
//
// Inputs are kept minimal — region, environmentName (azd's instance discriminator),
// optional Clio region, optional custom domain.
// =============================================================================

targetScope = 'resourceGroup'

@minLength(1)
@maxLength(64)
@description('A short, unique name for this deployment instance (lowercase, alphanumeric).')
param environmentName string

@description('Primary Azure region for all resources.')
param location string = resourceGroup().location

@allowed([ 'us', 'ca', 'eu', 'au' ])
@description('Clio region to talk to.')
param clioRegion string = 'us'

@description('How verbose the application log is. error | warn | info | debug.')
param logLevel string = 'info'

@allowed([ 'none', 'metadata', 'full' ])
@description('Audit log mode.')
param auditMode string = 'metadata'

@description('When true, the server accepts DELETE operations. Default false.')
param allowDestructive bool = false

@description('Optional default Clio user id used for matter creation when callers omit it.')
param defaultUserId string = ''

@description('Container image tag to deploy. Set to "latest" or a git sha by azd.')
param imageTag string = 'latest'

@description('Container CPU. 0.5 is plenty for a stateless MCP gateway at moderate volume.')
param containerCpu string = '0.5'

@description('Container memory.')
param containerMemory string = '1.0Gi'

@description('Minimum replicas. Set to 0 for scale-to-zero (cold-start tradeoff) or 1+ for warm.')
param minReplicas int = 1

@description('Maximum replicas. Stateless server scales out cleanly.')
param maxReplicas int = 4

// ---------- naming ----------------------------------------------------------
var resourceSuffix = toLower(replace(environmentName, '_', ''))
var nameBase = 'cliomcp-${resourceSuffix}'

// Storage account names: 3-24 chars, lowercase, no hyphens.
var storageAccountName = toLower(substring(replace('cliomcp${resourceSuffix}', '-', ''), 0, min(24, length(replace('cliomcp${resourceSuffix}', '-', '')))))

// ACR names: 5-50 chars, alphanumeric only.
var acrName = toLower(substring(replace('cliomcpacr${resourceSuffix}', '-', ''), 0, min(50, length(replace('cliomcpacr${resourceSuffix}', '-', '')))))

// Key Vault names: 3-24, alphanumeric+hyphens.
var keyVaultName = take('kv-${nameBase}', 24)

// ---------- Log Analytics + App Insights ------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${nameBase}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${nameBase}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// ---------- Managed identity ------------------------------------------------
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${nameBase}'
  location: location
}

// ---------- ACR -------------------------------------------------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, identity.id, 'acrpull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d') // AcrPull
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Key Vault (RBAC) ------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, identity.id, 'kvsecretsuser')
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------- Storage + File Share for state ----------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // Container Apps environment storage uses the account key
    networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
  }
}

resource fileServices 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileServices
  name: 'clio-state'
  properties: {
    accessTier: 'TransactionOptimized'
    shareQuota: 10
  }
}

// ---------- Container Apps environment + storage mount ----------------------
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${nameBase}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource caeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: cae
  name: 'clio-state'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: fileShare.name
      accessMode: 'ReadWrite'
    }
  }
}

// ---------- Container App ---------------------------------------------------
resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-${nameBase}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  dependsOn: [ acrPull, kvSecretsUser ]
  properties: {
    managedEnvironmentId: cae.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8765
        transport: 'http'
        allowInsecure: false
        traffic: [ { latestRevision: true, weight: 100 } ]
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        {
          name: 'clio-client-id'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/clio-client-id'
          identity: identity.id
        }
        {
          name: 'clio-client-secret'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/clio-client-secret'
          identity: identity.id
        }
        {
          name: 'clio-encryption-key'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/clio-encryption-key'
          identity: identity.id
        }
        {
          name: 'clio-http-auth-tokens'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/clio-http-auth-tokens'
          identity: identity.id
        }
        {
          name: 'clio-refresh-token'
          keyVaultUrl: '${kv.properties.vaultUri}secrets/clio-refresh-token'
          identity: identity.id
        }
      ]
    }
    template: {
      revisionSuffix: substring(uniqueString(imageTag, deployment().name), 0, 8)
      containers: [
        {
          name: 'clio-mcp'
          image: '${acr.properties.loginServer}/clio-mcp:${imageTag}'
          resources: {
            cpu: json(containerCpu)
            memory: containerMemory
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'CLIO_TRANSPORT', value: 'http' }
            { name: 'CLIO_HTTP_HOST', value: '0.0.0.0' }
            { name: 'CLIO_HTTP_PORT', value: '8765' }
            { name: 'CLIO_REGION', value: clioRegion }
            { name: 'CLIO_STATE_DIR', value: '/state' }
            { name: 'CLIO_AUDIT_MODE', value: auditMode }
            { name: 'CLIO_ALLOW_DESTRUCTIVE', value: string(allowDestructive) }
            { name: 'CLIO_DEFAULT_USER_ID', value: defaultUserId }
            { name: 'LOG_LEVEL', value: logLevel }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'CLIO_CLIENT_ID', secretRef: 'clio-client-id' }
            { name: 'CLIO_CLIENT_SECRET', secretRef: 'clio-client-secret' }
            { name: 'CLIO_ENCRYPTION_KEY', secretRef: 'clio-encryption-key' }
            { name: 'CLIO_HTTP_AUTH_TOKENS', secretRef: 'clio-http-auth-tokens' }
            { name: 'CLIO_BOOTSTRAP_REFRESH_TOKEN', secretRef: 'clio-refresh-token' }
          ]
          volumeMounts: [
            { volumeName: 'state', mountPath: '/state' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8765 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8765 }
              periodSeconds: 10
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'state'
          storageType: 'AzureFile'
          storageName: caeStorage.name
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

// ---------- Outputs ---------------------------------------------------------
output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = resourceGroup().name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.properties.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = acr.name
output AZURE_KEY_VAULT_NAME string = kv.name
output AZURE_KEY_VAULT_ENDPOINT string = kv.properties.vaultUri
output AZURE_IDENTITY_CLIENT_ID string = identity.properties.clientId
output AZURE_IDENTITY_RESOURCE_ID string = identity.id
output APPLICATIONINSIGHTS_CONNECTION_STRING string = appInsights.properties.ConnectionString
output SERVICE_API_NAME string = app.name
output SERVICE_API_URI string = 'https://${app.properties.configuration.ingress.fqdn}'
output SERVICE_API_MCP_ENDPOINT string = 'https://${app.properties.configuration.ingress.fqdn}/mcp'
