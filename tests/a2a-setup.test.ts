import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { A2ADiscovery, BindingConfig, IntegrationManagementView } from '../src/integration-types'
import type { Message } from '../src/types'
import { a2aSetupConfig, a2aSetupEnabled, a2aTrialResult, type A2ASetupIdentity, type A2ATrialIdentity } from '../src/lib/a2a-setup'

const company = 'workspace'
const identity: A2ASetupIdentity = { requestId: 'request', connectionId: 'new-connection', bindingId: 'new-binding', name: 'Report', memberId: 'external-member' }
const discovery: A2ADiscovery = {
  revision: 3,
  target: { backend: 'a2a', baseUrl: 'http://127.0.0.1:5818/a2a', secretRef: 'key', credentialRevision: '2', knowledgeBaseIds: [], remoteAgentIds: ['report'], toolNames: [] },
  card: { name: 'Report', description: 'Fixture', version: '1', protocolVersion: '0.3.0', cardSha256: 'a'.repeat(64),
    skill: { id: 'report', name: 'Report', description: 'Fixture', tags: [] }, inputModes: ['text/plain'], outputModes: ['text/markdown'], advertisedCapabilities: {} },
}
const existing: BindingConfig = { schemaVersion: 1,
  connections: [{ id: 'original', version: 'r3', kind: 'tool', backend: 'mcp', baseUrl: 'http://127.0.0.1:5819/mcp', secretRef: 'tools', credentialRevision: '1', knowledgeBaseIds: [], enabled: false }], bindings: [] }
function published(): IntegrationManagementView {
  const config = a2aSetupConfig(existing, company, discovery, identity, 'external-member')
  for (const connection of config.connections) connection.version = 'r4'
  for (const binding of config.bindings) { binding.version = 'r4'; binding.connectionVersion = 'r4' }
  return { revision: 4, config, targets: [discovery.target], history: [], invocations: [],
    members: [{ id: 'external-member', name: 'Report', executionKind: 'external-service', enabled: true }] }
}
const trial: A2ATrialIdentity = { conversationId: 'direct', memberId: 'external-member', clientId: 'client-request', sourceId: 'source' }
function completedMessages(): Message[] {
  return [
    { id: 'source', conversationId: 'direct', authorId: 'human', kind: 'text', body: 'input', at: '2026-10-02T00:00:00Z', clientId: 'client-request',
      externalDeliveries: [{ id: 'delivery', memberId: 'external-member', sourceMessageId: 'source', status: 'completed', reason: null,
        invocationId: 'invocation', finalMessageId: 'reply', textOnly: false, expired: false, revision: 2 }] },
    { id: 'reply', conversationId: 'direct', authorId: 'external-member', kind: 'text', body: 'report-output', at: '2026-10-02T00:00:01Z', quotedMessageId: 'source',
      externalResult: { deliveryId: 'delivery', invocationId: 'invocation', citationStatus: 'none', citations: [] } },
  ]
}

test('setup appends one scoped authorization without changing existing configuration or generating new retry identities', () => {
  const before = structuredClone(existing)
  const config = a2aSetupConfig(existing, company, discovery, identity, 'external-member')
  assert.deepEqual(existing, before)
  assert.deepEqual(config.connections[0], before.connections[0])
  assert.equal(config.connections.length, 2)
  assert.equal(config.bindings.length, 1)
  const binding = config.bindings[0]
  assert.equal(binding.capabilityId, 'a2a.agent')
  if (binding.capabilityId !== 'a2a.agent') throw new Error('wrong_fixture_kind')
  assert.deepEqual(binding.subjectIds, ['external-member'])
  assert.deepEqual(binding.companyIds, [company])
  assert.equal(binding.approval?.cardSha256, discovery.card.cardSha256)
  assert.equal(binding.approval?.effectiveConfigDigest, discovery.card.cardSha256)
  assert.equal(binding.approval?.tenantId, company)
  assert.deepEqual(a2aSetupConfig(existing, company, discovery, identity, 'external-member'), config)
  assert.throws(() => a2aSetupConfig(config, company, discovery, identity, 'external-member'), /a2a_setup_already_saved/)
})

test('an authoritative matching saved configuration reconciles a lost save response', () => {
  const view = published()
  assert.equal(a2aSetupEnabled(view, company, discovery, identity), true)
  view.config.connections[1].version = 'r5'
  view.config.bindings[0].connectionVersion = 'r5'
  assert.equal(a2aSetupEnabled(view, company, discovery, identity), true)
})

test('disabled, partial and differently scoped publications are never accepted as this setup', () => {
  const changes: Array<(view: IntegrationManagementView) => void> = [
    view => { view.members[0].enabled = false },
    view => { view.members[0].executionKind = 'native' },
    view => { view.config.connections[1].enabled = false },
    view => { view.config.connections[1].credentialRevision = 'other' },
    view => { view.config.connections[1].baseUrl = 'http://127.0.0.1:9999/a2a' },
    view => { view.config.bindings[0].subjectIds = ['other-member'] },
    view => { view.config.bindings[0].companyIds = ['other-workspace'] },
    view => { view.config.bindings[0].connectionVersion = 'stale' },
    view => { view.config.bindings = [] },
  ]
  for (const change of changes) {
    const view = published(); change(view)
    assert.equal(a2aSetupEnabled(view, company, discovery, identity), false)
  }
})

test('a trial needs both live completed authorization and the matching published reply', () => {
  const messages = completedMessages()
  assert.equal(a2aTrialResult(messages, trial).status, 'pending')
  assert.equal(a2aTrialResult(messages.slice(0, 1), trial, { status: 'completed' }).status, 'pending')
  assert.deepEqual(a2aTrialResult(messages, trial, { status: 'completed' }), { status: 'completed', deliveryId: 'delivery', answer: messages[1].body })
})

test('a lost submission response is correlated by its original clientId rather than resent', () => {
  const { sourceId: _sourceId, ...unconfirmed } = trial
  assert.equal(a2aTrialResult(completedMessages(), unconfirmed, { status: 'completed' }).status, 'completed')
  assert.equal(a2aTrialResult(completedMessages(), { ...unconfirmed, clientId: 'another-request' }, { status: 'completed' }).status, 'pending')
})

test('another author, room, source or invocation cannot make the trial pass', () => {
  for (const field of ['authorId', 'conversationId', 'quotedMessageId', 'id'] as const) {
    const messages = completedMessages(); messages[1][field] = 'unrelated'
    assert.equal(a2aTrialResult(messages, trial, { status: 'completed' }).status, 'pending')
  }
  const messages = completedMessages()
  assert.ok(messages[1].externalResult)
  messages[1].externalResult.invocationId = 'other-invocation'
  assert.equal(a2aTrialResult(messages, trial, { status: 'completed' }).status, 'pending')
})

test('unknown, failed, revoked and expired deliveries never expose a successful result', () => {
  for (const [remote, status] of [['queued', 'pending'], ['running', 'pending'], ['blocked_unknown', 'unknown'], ['failed', 'failed'], ['withheld', 'withheld'], ['expired', 'withheld']]) {
    const result = a2aTrialResult(completedMessages(), trial, { status: remote })
    assert.equal(result.status, status)
    assert.equal('answer' in result, false)
  }
  assert.equal(a2aTrialResult(completedMessages(), trial, { status: 'completed', expired: true }).status, 'withheld')
})
