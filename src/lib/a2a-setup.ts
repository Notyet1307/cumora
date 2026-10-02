import type { A2ADiscovery, BindingConfig, IntegrationManagementView } from '../integration-types'
import type { Message } from '../types'

/** One user-approved creation attempt; retries keep these identities. */
export interface A2ASetupIdentity {
  requestId: string
  connectionId: string
  bindingId: string
  name: string
  memberId?: string
}

export function a2aSetupConfig(config: BindingConfig, companyId: string, discovery: A2ADiscovery,
  identity: A2ASetupIdentity, memberId: string): BindingConfig {
  if (config.connections.some(item => item.id === identity.connectionId) || config.bindings.some(item => item.id === identity.bindingId)) {
    throw new Error('a2a_setup_already_saved')
  }
  const { target, card } = discovery
  return {
    ...config,
    connections: [...config.connections, { id: identity.connectionId, version: 'pending', kind: 'agent-service', backend: 'a2a',
      baseUrl: target.baseUrl, secretRef: target.secretRef, credentialRevision: target.credentialRevision, knowledgeBaseIds: [], enabled: true }],
    bindings: [...config.bindings, { id: identity.bindingId, version: 'pending', connectionId: identity.connectionId,
      connectionVersion: 'pending', companyIds: [companyId], subjectIds: [memberId], enabled: true,
      kind: 'agent-service', capabilityId: 'a2a.agent', remoteAgentId: card.skill.id,
      approval: { authorizationVersion: 'pending', tenantId: companyId, effectiveConfigDigest: card.cardSha256,
        cardSha256: card.cardSha256, protocolVersion: card.protocolVersion } }],
  }
}

/** Reconcile an ambiguous save from authoritative state without publishing again. */
export function a2aSetupEnabled(view: IntegrationManagementView, companyId: string, discovery: A2ADiscovery, identity: A2ASetupIdentity): boolean {
  const binding = view.config.bindings.find(item => item.id === identity.bindingId)
  const connection = view.config.connections.find(item => item.id === identity.connectionId)
  const member = view.members.find(item => item.id === identity.memberId)
  return member?.executionKind === 'external-service' && member.enabled && connection?.enabled === true
    && connection.backend === 'a2a' && connection.kind === 'agent-service'
    && connection.baseUrl === discovery.target.baseUrl && connection.secretRef === discovery.target.secretRef
    && connection.credentialRevision === discovery.target.credentialRevision
    && binding?.capabilityId === 'a2a.agent' && binding.enabled && binding.connectionId === connection.id
    && binding.connectionVersion === connection.version && binding.companyIds.length === 1 && binding.companyIds[0] === companyId
    && binding.subjectIds.length === 1 && binding.subjectIds[0] === identity.memberId && binding.remoteAgentId === discovery.card.skill.id
    && binding.approval?.tenantId === companyId && binding.approval.protocolVersion === discovery.card.protocolVersion
    && binding.approval.cardSha256 === discovery.card.cardSha256 && binding.approval.effectiveConfigDigest === discovery.card.cardSha256
}

export interface A2ATrialIdentity {
  readonly conversationId: string
  readonly memberId: string
  readonly clientId: string
  sourceId?: string
}
export type A2ATrialResult =
  | { status: 'pending' | 'failed' | 'unknown' | 'withheld'; deliveryId?: string }
  | { status: 'completed'; deliveryId: string; answer: string }

/** A queued/HTTP-accepted request or an unrelated reply is never business success. */
export function a2aTrialResult(messages: readonly Message[], trial: A2ATrialIdentity,
  current?: { status: string; expired?: boolean }): A2ATrialResult {
  const source = messages.find(message => message.conversationId === trial.conversationId
    && (trial.sourceId ? message.id === trial.sourceId : message.clientId === trial.clientId))
  const delivery = source?.externalDeliveries?.find(item => item.sourceMessageId === source.id && item.memberId === trial.memberId)
  if (!source || !delivery) return { status: 'pending' }
  const deliveryId = delivery.id
  if (current?.expired || current?.status === 'expired' || current?.status === 'withheld') return { status: 'withheld', deliveryId }
  if (current?.status === 'blocked_unknown' || current?.status === 'unknown') return { status: 'unknown', deliveryId }
  if (current?.status === 'failed') return { status: 'failed', deliveryId }
  const reply = messages.find(message => message.id === delivery.finalMessageId && message.conversationId === trial.conversationId
    && message.authorId === trial.memberId && message.quotedMessageId === source.id
    && message.externalResult?.deliveryId === deliveryId && message.externalResult.invocationId === delivery.invocationId)
  if (current?.status === 'completed' && delivery.status === 'completed' && !delivery.expired && reply?.body.trim()) {
    return { status: 'completed', deliveryId, answer: reply.body }
  }
  return { status: 'pending', deliveryId }
}
