import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { InvocationStore } from '../integrations/invocations.js'
import { resetAllTables, teardownAll } from './_helpers.js'
import { BindingResolver, type BindingConfig } from '../integrations/bindings.js'
import { OperatorAgent } from '../integrations/operator-agent.js'

beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

// Only the repository's authorized, throwaway integration database runner may execute this file.
test('source deduplication, actor exclusion and generation fences survive competing database owners', async () => {
  const store = new InvocationStore(pool)
  const actor = { companyId: `probe-${randomUUID()}`, subjectId: 'operator' }
  const input = { sourceId: randomUUID(), query: 'synthetic', conversationScope: 'one', snapshot: { bindingId: 'b', bindingVersion: '1', connectionId: 'c', connectionVersion: '1', authorizationVersion: '1', remoteAgentId: '11111111-1111-4111-8111-111111111111', tenantId: '1', knowledgeBaseIds: ['kb'], effectiveConfigDigest: 'a'.repeat(64) } }
  const [a, b] = await Promise.all([store.accept(actor, input), store.accept(actor, input)])
  assert.equal(a.id, b.id)
  await assert.rejects(store.accept(actor, { ...input, query: 'different' }), /source_conflict/)
  const again = await store.accept(actor, { ...input, snapshot: { ...input.snapshot, bindingVersion: '2' } })
  assert.equal(again.id, a.id)
  const next = await store.accept(actor, { ...input, sourceId: randomUUID() })
  assert.notEqual(next.id, a.id)
  const claims = await Promise.all([store.claim(actor, a.id), store.claim(actor, next.id)])
  assert.equal(claims.filter(Boolean).length, 1)
  const owner = claims.find(Boolean)!
  await pool.query("UPDATE external_invocations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.id])
  await store.expireLeases(actor)
  assert.equal((await store.get(actor, owner.id))?.status, 'unknown')
  await assert.rejects(store.saveResult(actor, owner.id, owner.generation, { status: 'completed', answer: 'late' }), /owner_lost/)
  assert.equal(await store.claim(actor, next.id), null)
  assert.equal(await store.get({ ...actor, companyId: 'other' }, owner.id), null)
  await pool.query("UPDATE external_invocations SET content_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [owner.id])
  await store.purgeExpired()
  const expired = await store.get(actor, owner.id)
  assert.equal(expired?.input_text, null)
  assert.equal(expired?.result, null)
  assert.equal(expired?.status, 'unknown')
  assert.equal((await store.accept(actor, input)).id, a.id)
  await assert.rejects(store.accept(actor, { ...input, query: 'changed after expiry' }), /source_conflict/)
})

function operatorConfig(): BindingConfig {
  return {
    schemaVersion: 1,
    connections: [{ id: 'local', version: '1', kind: 'agent-service', backend: 'weknora', baseUrl: 'http://127.0.0.1:8180/api/v1', secretRef: 'chat', credentialRevision: '1', knowledgeBaseIds: ['kb'], enabled: true }],
    bindings: [{ id: 'agent', version: '1', kind: 'agent-service', capabilityId: 'weknora.agent', remoteAgentId: '11111111-1111-4111-8111-111111111111', connectionId: 'local', connectionVersion: '1', companyIds: ['test-company'], subjectIds: ['test-operator'], enabled: true,
      approval: { authorizationVersion: '1', tenantId: '1', effectiveConfigDigest: 'a'.repeat(64), mode: 'smart-reasoning', allowedTools: ['knowledge_search'], credentialCapability: 'chat', kbSelectionMode: 'selected', retrieveKbOnlyWhenMentioned: false, mcpSelectionMode: 'none', skillsSelectionMode: 'none', sandboxEnabled: false, memoryEnabled: false } }],
  }
}
const actor = { companyId: 'test-company', subjectId: 'test-operator' }
const frame = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`

test('lost Session acknowledgement and lost terminal evidence block all automatic resubmission', async t => {
  let mode = 'lost-session', posts = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    posts++
    if (mode === 'lost-session') throw new Error('connection lost after accept')
    if (url.endsWith('/sessions')) return Response.json({ data: { id: 'session-1' } })
    return new Response(frame({ response_type: 'agent_query', id: 'request-1', done: true, session_id: 'session-1', assistant_message_id: 'message-1', data: { user_message_id: 'user-1' } }) + frame({ response_type: 'answer', content: 'partial', data: { event_id: 'answer-1' } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const service = new OperatorAgent(new BindingResolver(operatorConfig(), { chat: 'test-chat-secret' }), new InvocationStore(pool))
  const input = { sourceId: randomUUID(), conversationScope: 'scope', query: 'synthetic' }
  const lost = await service.submit(actor, input)
  assert.equal(lost.status, 'unknown')
  assert.equal((await service.submit(actor, input)).id, lost.id)
  const pending = await service.submit(actor, { ...input, sourceId: randomUUID() })
  assert.equal(pending.status, 'queued')
  assert.equal(posts, 1)
  await resetAllTables()
  mode = 'lost-terminal'
  const partial = await service.submit(actor, input)
  assert.equal(partial.status, 'unknown')
  assert.equal(partial.remote_ids?.assistantMessageId, 'message-1')
  assert.equal(partial.result?.answer, 'partial')
  assert.equal((await service.submit(actor, input)).id, partial.id)
  assert.equal(posts, 3)
  await service.stop(actor, partial.id)
  assert.equal((await service.get(actor, partial.id)).status, 'unknown')
})

test('sessions isolate scopes, completion is persisted, and revoked grants cannot deliver saved results', async t => {
  let sessions = 0, chats = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/sessions')) return Response.json({ data: { id: `session-${++sessions}` } })
    const session = url.split('/').at(-1)!
    chats++
    return new Response(frame({ response_type: 'agent_query', id: `request-${chats}`, done: true, session_id: session, assistant_message_id: `message-${chats}`, data: { user_message_id: `user-${chats}` } }) + frame({ response_type: 'answer', content: 'complete answer', data: { event_id: 'answer-1' } }) + frame({ response_type: 'complete', done: true }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const config = operatorConfig()
  const resolver = new BindingResolver(config, { chat: 'test-chat-secret' })
  const service = new OperatorAgent(resolver, new InvocationStore(pool))
  const first = await service.submit(actor, { sourceId: randomUUID(), conversationScope: 'one', query: 'synthetic' })
  assert.equal(first.status, 'completed')
  assert.equal((await service.get(actor, first.id)).result?.answer, 'complete answer')
  await service.submit(actor, { sourceId: randomUUID(), conversationScope: 'one', query: 'follow-up' })
  assert.equal(sessions, 1)
  await service.submit(actor, { sourceId: randomUUID(), conversationScope: 'two', query: 'synthetic' })
  assert.equal(sessions, 2)
  assert.equal(chats, 3)
  config.bindings[0].version = '2'
  config.bindings[0].enabled = false
  new BindingResolver(config, { chat: 'test-chat-secret' }, resolver)
  await assert.rejects(service.get(actor, first.id), /binding_version_conflict/)
  assert.equal(chats, 3)
})

test('a failed completion commit never reports success and cannot cause another POST', async t => {
  await pool.query(`CREATE SEQUENCE external_completion_attempt;
    CREATE FUNCTION reject_external_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='completed' THEN PERFORM nextval('external_completion_attempt'); RAISE EXCEPTION 'synthetic completion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_external_complete BEFORE UPDATE ON external_invocations FOR EACH ROW EXECUTE FUNCTION reject_external_complete()`)
  t.after(async () => { await pool.query('DROP TRIGGER IF EXISTS reject_external_complete ON external_invocations; DROP FUNCTION IF EXISTS reject_external_complete(); DROP SEQUENCE IF EXISTS external_completion_attempt') })
  let posts = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    posts++
    if (url.endsWith('/sessions')) return Response.json({ data: { id: 'session-1' } })
    return new Response(frame({ response_type: 'agent_query', id: 'request-1', done: true, session_id: 'session-1', assistant_message_id: 'message-1', data: { user_message_id: 'user-1' } }) + frame({ response_type: 'answer', content: 'complete', data: { event_id: 'answer-1' } }) + frame({ response_type: 'complete', done: true }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const service = new OperatorAgent(new BindingResolver(operatorConfig(), { chat: 'test-chat-secret' }), new InvocationStore(pool))
  const input = { sourceId: randomUUID(), conversationScope: 'one', query: 'synthetic' }
  const result = await service.submit(actor, input)
  assert.equal(result.status, 'unknown')
  assert.equal(result.remote_ids?.assistantMessageId, 'message-1')
  assert.equal((await service.submit(actor, input)).id, result.id)
  assert.equal(posts, 2)
  const attempt = await pool.query('SELECT is_called FROM external_completion_attempt')
  assert.equal(attempt.rows[0].is_called, true, 'must reach the injected completion failure, not fail earlier')
})

test('explicit replay has one database owner, replaces partial output and preserves long results until expiry', async t => {
  let posts = 0, observations = 0
  const answer = '完整结果'.repeat(20000)
  const query = { response_type: 'agent_query', id: 'request-1', done: true, session_id: 'session-1', assistant_message_id: 'message-1', data: { user_message_id: 'user-1' } }
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') observations++; else posts++
    if (url.endsWith('/sessions')) return Response.json({ data: { id: 'session-1' } })
    const replay = init?.method === 'GET'
    const preamble = frame({ response_type: 'answer', content: 'Let me search', data: { event_id: 'discarded' } })
      + frame({ response_type: 'tool_call', data: { tool_name: 'knowledge_search', tool_call_id: 'tool-1' } })
    return new Response(frame(query) + preamble + frame({ response_type: 'answer', content: replay ? answer : 'partial', data: { event_id: 'answer-1' } }) + (replay ? frame({ response_type: 'complete', done: true }) : ''), { headers: { 'content-type': 'text/event-stream' } })
  })
  const store = new InvocationStore(pool)
  const service = new OperatorAgent(new BindingResolver(operatorConfig(), { chat: 'test-chat-secret' }), store)
  const input = { sourceId: randomUUID(), conversationScope: 'one', query: 'synthetic' }
  const partial = await service.submit(actor, input)
  assert.equal(partial.result?.answer, 'partial')
  await Promise.all([service.observe(actor, partial.id), service.observe(actor, partial.id)])
  const complete = await service.get(actor, partial.id)
  assert.equal(complete.status, 'completed')
  assert.equal(complete.result?.answer, answer)
  assert.equal(observations, 1)
  assert.equal(posts, 2)
  await service.observe(actor, partial.id)
  await service.stop(actor, partial.id)
  assert.equal(observations, 1)
  assert.equal(posts, 2)
  await pool.query("UPDATE external_invocations SET content_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [partial.id])
  assert.equal((await store.get(actor, partial.id))?.result, null)
  await store.purgeExpired()
  const expired = await service.get(actor, partial.id)
  assert.equal(expired.status, 'completed')
  assert.deepEqual(expired.remote_ids, complete.remote_ids)
  assert.equal(expired.input_digest, complete.input_digest)
  assert.equal((await service.submit(actor, input)).id, partial.id)
  assert.equal(posts, 2)
})

test('expired replay stays unknown, keeps prior partial, and a queued cancellation never posts', async t => {
  let posts = 0, observations = 0, stops = 0
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') { observations++; return new Response('', { status: 404 }) }
    if (url.endsWith('/stop')) { stops++; return Response.json({ success: true }) }
    posts++
    if (url.endsWith('/sessions')) return Response.json({ data: { id: 'session-1' } })
    return new Response(frame({ response_type: 'agent_query', id: 'request-1', done: true, session_id: 'session-1', assistant_message_id: 'message-1', data: { user_message_id: 'user-1' } }) + frame({ response_type: 'answer', content: 'original partial', data: { event_id: 'answer-1' } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const service = new OperatorAgent(new BindingResolver(operatorConfig(), { chat: 'test-chat-secret' }), new InvocationStore(pool))
  const first = await service.submit(actor, { sourceId: randomUUID(), conversationScope: 'one', query: 'synthetic' })
  await service.observe(actor, first.id)
  const unchanged = await service.observe(actor, first.id)
  assert.equal(unchanged.status, 'unknown')
  assert.equal(unchanged.result?.answer, 'original partial')
  assert.equal(observations, 1)
  await service.stop(actor, first.id)
  const stopped = await service.stop(actor, first.id)
  assert.equal(stopped.status, 'unknown')
  assert.equal(stopped.cancel_observation?.httpAccepted, true)
  assert.equal(stops, 1)
  const nextInput = { sourceId: randomUUID(), conversationScope: 'two', query: 'synthetic' }
  const queued = await service.submit(actor, nextInput)
  assert.equal(queued.status, 'queued')
  assert.equal((await service.cancelQueued(actor, queued.id)).status, 'canceled')
  assert.equal((await service.submit(actor, nextInput)).status, 'canceled')
  assert.equal(posts, 2)
})
