import type { BindingConfig, IntegrationBinding, IntegrationConnection } from '../server/src/integrations/bindings'

export type { BindingConfig, IntegrationBinding, IntegrationConnection }
export interface IntegrationTarget {
  secretRef: string
  credentialRevision: string
  backend: IntegrationConnection['backend']
  baseUrl: string
  knowledgeBaseIds: string[]
  remoteAgentIds: string[]
  toolNames: string[]
}
export interface IntegrationMember {
  id: string
  name: string
  executionKind: 'native' | 'external-service'
  enabled: boolean
}
export interface IntegrationRevision {
  revision: number
  action: string
  actorId: string
  createdAt: string
}
export interface IntegrationInvocationView {
  id: string
  subjectId: string
  status: string
  bindingId: string
  bindingVersion: string
  connectionId: string
  connectionVersion: string
  createdAt: string
  remoteIds: Record<string, string> | null
}
export interface IntegrationManagementView {
  revision: number
  config: BindingConfig
  targets: IntegrationTarget[]
  members: IntegrationMember[]
  history: IntegrationRevision[]
  invocations: IntegrationInvocationView[]
}
export type IntegrationCheckStatus = 'pass' | 'fail' | 'not_verified'
export interface IntegrationProbeResult {
  connectivity: IntegrationCheckStatus
  authentication: IntegrationCheckStatus
  permission: IntegrationCheckStatus
  business: IntegrationCheckStatus
  code: string
}
