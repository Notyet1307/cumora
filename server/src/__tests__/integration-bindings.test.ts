import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BindingConfigError, BindingResolver, type BindingConfig } from '../integrations/bindings.js'

function config(): BindingConfig {
  return {
    schemaVersion: 1,
    connections: [{ id: 'search', version: '1', kind: 'tool', backend: 'weknora', baseUrl: 'http://weknora.test/api/v1', secretRef: 'key', credentialRevision: '1', knowledgeBaseIds: ['kb-a'], enabled: true }],
    bindings: [{ id: 'reader', version: '1', kind: 'tool', capabilityId: 'weknora.search', connectionId: 'search', connectionVersion: '1', companyIds: ['co-a'], subjectIds: ['compliance'], knowledgeBaseId: 'kb-a', enabled: true }],
  }
}
const actor = { companyId: 'co-a', subjectId: 'compliance' }

test('only the authorized actor receives a usable retrieval connection', () => {
  const resolver = new BindingResolver(config(), { key: 'fake-a' })
  const allowed = resolver.resolve(actor, 'weknora.search', 'tool')
  assert.equal(allowed.ok, true)
  if (!allowed.ok) return
  assert.equal(allowed.binding.knowledgeBaseId, 'kb-a')
  assert.equal(allowed.binding.baseUrl, 'http://weknora.test/api/v1')
  assert.equal(allowed.binding.apiKey, 'fake-a')
  for (const caller of [
    { companyId: 'co-b', subjectId: 'compliance' },
    { companyId: 'co-a', subjectId: 'reporter' },
    { companyId: null, subjectId: 'compliance' },
  ]) {
    const denied = resolver.resolve(caller, 'weknora.search', 'tool')
    assert.equal(denied.ok, false)
    assert.equal('binding' in denied, false)
    assert.equal(JSON.stringify(denied).includes('fake-a'), false)
  }
})

test('duplicate IDs and same-version replacement cannot silently change authorization', () => {
  const initial = config()
  const previous = new BindingResolver(initial, { key: 'fake-a' })
  const duplicate = config()
  duplicate.connections.push({ ...duplicate.connections[0] })
  assert.throws(() => new BindingResolver(duplicate, { key: 'fake-a' }), (e: unknown) => e instanceof BindingConfigError && e.code === 'duplicate_id')
  const duplicateBinding = config()
  duplicateBinding.bindings.push({ ...duplicateBinding.bindings[0] })
  assert.throws(() => new BindingResolver(duplicateBinding, { key: 'fake-a' }), (e: unknown) => e instanceof BindingConfigError && e.code === 'duplicate_id')
  const changed = config()
  changed.connections[0].baseUrl = 'http://other.test/api/v1'
  assert.throws(() => new BindingResolver(changed, { key: 'fake-a' }, previous), (e: unknown) => e instanceof BindingConfigError && e.code === 'version_conflict')
  const changedScope = config()
  changedScope.bindings[0].subjectIds.push('reporter')
  assert.throws(() => new BindingResolver(changedScope, { key: 'fake-a' }, previous), (e: unknown) => e instanceof BindingConfigError && e.code === 'version_conflict')
  assert.throws(() => new BindingResolver(config(), { key: 'rotated-secret' }, previous), (e: unknown) => e instanceof BindingConfigError && e.code === 'version_conflict')
})

test('operator snapshots isolate connections, credentials and in-flight results', () => {
  const original = config()
  const secrets = { key: 'fake-a' }
  const first = new BindingResolver(original, secrets)
  const one = first.resolve(actor, 'weknora.search', 'tool')
  assert.equal(one.ok, true)
  if (!one.ok) return
  original.connections[0].version = '2'
  original.connections[0].credentialRevision = '2'
  original.connections[0].baseUrl = 'http://second.test/api/v1'
  original.connections[0].knowledgeBaseIds = ['kb-b']
  original.bindings[0] = { ...original.bindings[0], kind: 'tool', capabilityId: 'weknora.search', knowledgeBaseId: 'kb-b', version: '2', connectionVersion: '2' }
  secrets.key = 'fake-b'
  const second = new BindingResolver(original, secrets, first)
  const two = second.resolve(actor, 'weknora.search', 'tool')
  assert.equal(two.ok, true)
  if (!two.ok) return
  assert.equal(two.binding.baseUrl, 'http://second.test/api/v1')
  assert.equal(two.binding.knowledgeBaseId, 'kb-b')
  assert.equal(two.binding.apiKey, 'fake-b')
  assert.equal(one.binding.baseUrl, 'http://weknora.test/api/v1')
  assert.equal(one.binding.knowledgeBaseId, 'kb-a')
  assert.equal(one.binding.apiKey, 'fake-a')
  assert.throws(() => { Object.assign(one.binding, { knowledgeBaseId: 'kb-b' }) }, TypeError)
  assert.equal(JSON.stringify(first).includes('fake-a'), false)
})

test('invalid, disabled, missing and out-of-scope bindings never yield a connection', () => {
  const cases: Array<[string, (c: BindingConfig) => void, string]> = [
    ['no binding', c => { c.bindings = [] }, 'missing_binding'],
    ['empty companies', c => { c.bindings[0].companyIds = [] }, 'company_denied'],
    ['empty subjects', c => { c.bindings[0].subjectIds = [] }, 'subject_denied'],
    ['binding disabled', c => { c.bindings[0].enabled = false }, 'disabled'],
    ['connection disabled', c => { c.connections[0].enabled = false }, 'disabled'],
    ['connection absent', c => { c.connections = [] }, 'missing_connection'],
    ['wrong revision', c => { c.bindings[0].connectionVersion = '9' }, 'version_conflict'],
    ['KB outside connection', c => { c.connections[0].knowledgeBaseIds = ['different-kb'] }, 'scope_denied'],
    ['conflicting grants', c => { c.bindings.push({ ...c.bindings[0], id: 'other-grant' }) }, 'ambiguous_binding'],
  ]
  for (const [name, mutate, code] of cases) {
    const candidate = config()
    mutate(candidate)
    const result = new BindingResolver(candidate, { key: 'fake-a' }).resolve(actor, 'weknora.search', 'tool')
    assert.deepEqual(result, { ok: false, code }, name)
  }
  assert.deepEqual(new BindingResolver(config(), {}).resolve(actor, 'weknora.search', 'tool'), { ok: false, code: 'missing_secret' })
  assert.deepEqual(new BindingResolver(config(), {}).resolve(actor, 'weknora.search', 'agent-service'), { ok: false, code: 'kind_mismatch' })
})

test('a full Agent declaration is unavailable and cannot fall back to retrieval', () => {
  const candidate = config()
  candidate.connections.push({ ...candidate.connections[0], id: 'agent', kind: 'agent-service', secretRef: 'agent-key' })
  candidate.bindings.push({ ...candidate.bindings[0], id: 'external', kind: 'agent-service', capabilityId: 'weknora.agent', remoteAgentId: 'remote-agent', connectionId: 'agent' })
  const resolver = new BindingResolver(candidate, { key: 'retrieve-key', 'agent-key': 'chat-key' })
  assert.deepEqual(resolver.resolve(actor, 'weknora.agent', 'agent-service'), { ok: false, code: 'unavailable' })
  assert.deepEqual(resolver.resolve(actor, 'weknora.agent', 'tool'), { ok: false, code: 'kind_mismatch' })
  const retrieval = resolver.resolve(actor, 'weknora.search', 'tool')
  assert.equal(retrieval.ok, true)
  if (retrieval.ok) assert.equal(retrieval.binding.apiKey, 'retrieve-key')
})

test('malformed operator data fails closed without exposing its values', () => {
  for (const mutate of [
    (c: BindingConfig) => { Object.assign(c, { schemaVersion: 2 }) },
    (c: BindingConfig) => { c.connections[0].baseUrl = 'file:///secret-value' },
    (c: BindingConfig) => { c.connections[0].baseUrl = 'http://user:secret-value@weknora.test' },
    (c: BindingConfig) => { c.connections[0].version = '' },
    (c: BindingConfig) => { Object.assign(c.bindings[0], { kind: 'agent-service' }) },
  ]) {
    const candidate = config()
    mutate(candidate)
    assert.throws(() => new BindingResolver(candidate, { key: 'secret-value' }), (e: unknown) => e instanceof BindingConfigError && e.code === 'invalid_config' && !e.message.includes('secret-value'))
  }
})

test('a replacement snapshot retires new resolutions on the old snapshot', () => {
  const first = new BindingResolver(config(), { key: 'fake-a' })
  const selected = first.resolve(actor, 'weknora.search', 'tool')
  assert.equal(selected.ok, true)
  const disabled = config()
  disabled.bindings[0].version = '2'
  disabled.bindings[0].enabled = false
  const next = new BindingResolver(disabled, { key: 'fake-a' }, first)
  assert.deepEqual(next.resolve(actor, 'weknora.search', 'tool'), { ok: false, code: 'disabled' })
  assert.deepEqual(first.resolve(actor, 'weknora.search', 'tool'), { ok: false, code: 'version_conflict' })
  if (selected.ok) assert.equal(selected.binding.knowledgeBaseId, 'kb-a')
})

test('two retrieval connections in one snapshot cannot exchange tenant scopes or credentials', () => {
  const candidate = config()
  candidate.connections.push({ ...candidate.connections[0], id: 'search-b', baseUrl: 'http://b.test/api/v1', secretRef: 'key-b', knowledgeBaseIds: ['kb-b'] })
  candidate.bindings.push({ ...candidate.bindings[0], id: 'reader-b', connectionId: 'search-b', companyIds: ['co-b'], kind: 'tool', capabilityId: 'weknora.search', knowledgeBaseId: 'kb-b' })
  const resolver = new BindingResolver(candidate, { key: 'fake-a', 'key-b': 'fake-b' })
  const a = resolver.resolve(actor, 'weknora.search', 'tool')
  const b = resolver.resolve({ ...actor, companyId: 'co-b' }, 'weknora.search', 'tool')
  assert.ok(a.ok && b.ok)
  assert.deepEqual([a.binding.baseUrl, a.binding.knowledgeBaseId, a.binding.apiKey], ['http://weknora.test/api/v1', 'kb-a', 'fake-a'])
  assert.deepEqual([b.binding.baseUrl, b.binding.knowledgeBaseId, b.binding.apiKey], ['http://b.test/api/v1', 'kb-b', 'fake-b'])
  assert.deepEqual(resolver.resolve({ ...actor, companyId: 'co-c' }, 'weknora.search', 'tool'), { ok: false, code: 'company_denied' })
})
