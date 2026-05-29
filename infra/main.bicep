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

@allowed([ 'oauth', 'static', 'hybrid' ])
@description('''Server auth mode.
  oauth  = per-user OAuth bridge to Clio (remote custom connector). Default.
  static = shared static bearer token + one shared Clio account.
  hybrid = both. oauth/hybrid REQUIRE PUBLIC_BASE_URL (derived below, HTTPS).''')
param authMode string = 'oauth'

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
// `environmentName` is the azd instance discriminator. We derive deterministic
// per-resource names from it, respecting Azure naming rules:
//   - ACR:           5-50 chars, alphanumeric only.
//   - Storage:       3-24 chars, lowercase alphanumeric.
//   - Key Vault:     3-24 chars, alphanumeric + hyphens, starts with letter.
//   - Other:         we use a `cliomcp-${suffix}` base.
// `take()` caps length without erroring on short inputs.
var resourceSuffix = toLower(replace(replace(environmentName, '_', ''), '-', ''))
var nameBase = 'cliomcp-${take(resourceSuffix, 14)}'
var storageAccountName = take('cliomcp${resourceSuffix}', 24)
var acrName = take('cliomcpacr${resourceSuffix}', 50)
var keyVaultName = take('kv-cliomcp-${resourceSuffix}', 24)

// Container App name. Must match the `app` resource's `name` below so the
// derived public URL equals the app's ingress FQDN.
var appName = 'ca-${nameBase}'

// Whether the static-only path is active. In pure 'oauth' mode the shared
// static bearer token + shared Clio refresh token are NOT used, so their
// Key Vault secret refs must be absent (a keyVaultUrl ref to a missing KV
// secret makes the container fail to start).
var staticEnabled = authMode != 'oauth'

// Public base URL for the OAuth issuer + connector endpoint. Derived from the
// Container Apps environment's stable default domain — NOT from the app's own
// ingress FQDN, which would be circular. For an external ingress Container App,
// the ingress FQDN is exactly `<appName>.<env defaultDomain>`. HTTPS is required
// by the MCP SDK's OAuth issuer (non-localhost). `cae` is declared before `app`.
var publicBaseUrl = 'https://${appName}.${cae.properties.defaultDomain}'

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
  name: appName
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
      // Always-present secrets (required in every mode) + static-only secrets
      // appended ONLY when authMode != 'oauth'. Each entry is a Key Vault
      // reference resolved via the user-assigned identity; a ref to a missing
      // KV secret would fail the container, so static-only refs are conditional.
      secrets: concat(
        [
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
        ],
        staticEnabled ? [
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
        ] : []
      )
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
          // Static-only env vars (CLIO_HTTP_AUTH_TOKENS / CLIO_BOOTSTRAP_REFRESH_TOKEN)
          // are appended ONLY when authMode != 'oauth', mirroring the conditional
          // secrets above (they reference secret names that only exist then).
          env: concat(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'CLIO_TRANSPORT', value: 'http' }
              { name: 'CLIO_HTTP_HOST', value: '0.0.0.0' }
              { name: 'CLIO_HTTP_PORT', value: '8765' }
              { name: 'MCP_AUTH_MODE', value: authMode }
              { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
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
            ],
            staticEnabled ? [
              { name: 'CLIO_HTTP_AUTH_TOKENS', secretRef: 'clio-http-auth-tokens' }
              { name: 'CLIO_BOOTSTRAP_REFRESH_TOKEN', secretRef: 'clio-refresh-token' }
            ] : []
          )
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

// OAuth remote custom connector wiring. publicBaseUrl is derived from the
// Container Apps environment domain and equals the app's ingress FQDN.
output MCP_AUTH_MODE string = authMode
output SERVICE_API_PUBLIC_BASE_URL string = publicBaseUrl
// Paste this into Claude as the custom connector URL, then sign in to Clio.
output SERVICE_API_MCP_ENDPOINT string = '${publicBaseUrl}/mcp'
// Register this redirect URI on your Clio Developer Application.
output CLIO_OAUTH_REDIRECT_URI string = '${publicBaseUrl}/oauth/clio/callback'
