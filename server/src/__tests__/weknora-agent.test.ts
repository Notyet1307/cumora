import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readAgentStream, WeknoraAgentClient } from '../integrations/weknora-agent.js'
import type { ResolvedAgentBinding } from '../integrations/bindings.js'

const ids = { sessionId: 'session-a', assistantMessageId: 'assistant-a', userMessageId: 'user-a', remoteRequestId: 'request-a' }
const query = { response_type: 'agent_query', id: ids.remoteRequestId, done: true, session_id: ids.sessionId, assistant_message_id: ids.assistantMessageId, data: { user_message_id: ids.userMessageId } }
const wire = (event: unknown) => `event: message\r\ndata: ${JSON.stringify(event)}\r\n\r\n`
function stream(text: string, oneByte = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({ start(c) { if (oneByte) for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); else c.enqueue(bytes); c.close() } })
}

test('wire framing survives UTF-8 byte boundaries and early done flags do not complete an invocation', async () => {
  const text = wire(query) + ': keepalive\r\n\r\n' + wire({ response_type: 'answer', content: '完整中文', done: false, data: { event_id: 'answer-1' } }) + wire({ response_type: 'answer', content: '', done: true, data: { event_id: 'answer-1' } })
  const partial = await readAgentStream(stream(text, true), ids.sessionId, async () => {})
  assert.equal(partial.status, 'unknown')
  assert.equal(partial.answer, '完整中文')
  const complete = await readAgentStream(stream(text + wire({ response_type: 'complete', done: true }), true), ids.sessionId, async () => {})
  assert.equal(complete.status, 'completed')
  assert.equal(complete.answer, '完整中文')
  assert.deepEqual(complete.ids, ids)
  assert.equal(complete.usage, null)
})

test('diagnostic tool errors do not fail a completed answer and cumulative references are not duplicated', async () => {
  const one = { knowledge_id: 'k', chunk_id: 'c', score: 0.5 }
  const events = [query, { response_type: 'error', done: false, content: 'tool unavailable' },
    { response_type: 'references', knowledge_references: [one] }, { response_type: 'references', data: { references: [one, { knowledge_id: 'k2' }] } },
    { response_type: 'answer', content: 'answer', data: { event_id: 'answer-1' } }, { response_type: 'complete', done: true, usage: { total_tokens: 12 }, data: { artifacts: [{ url: 'http://private.invalid/file' }] } }]
  const result = await readAgentStream(stream(events.map(wire).join('')), ids.sessionId, async () => {})
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.references, [one, { knowledge_id: 'k2' }])
  assert.deepEqual(result.usage, { total_tokens: 12 })
  assert.ok(result.limitations.includes('artifacts_not_downloaded'))
})

test('terminal error fails with partial output, but stop or contradictory complete stays unknown', async () => {
  const prefix = wire(query) + wire({ response_type: 'answer', content: 'partial', data: { event_id: 'answer-1' } })
  const failure = wire({ response_type: 'error', done: true, content: 'failed' })
  assert.equal((await readAgentStream(stream(prefix + failure), ids.sessionId, async () => {})).status, 'failed')
  for (const suffix of [failure + wire({ response_type: 'complete', done: true }), wire({ response_type: 'stop', done: true }) + wire({ response_type: 'complete', done: true })]) {
    const result = await readAgentStream(stream(prefix + suffix), ids.sessionId, async () => {})
    assert.equal(result.status, 'unknown')
    assert.equal(result.answer, 'partial')
  }
})

test('malformed frames, ID drift and persistence failure never produce a completed result', async () => {
  for (const suffix of [wire({ ...query, assistant_message_id: 'other' }), wire({ ...query, data: { user_message_id: ids.userMessageId, session_id: 'other' } }), wire({ response_type: 'answer', id: 'other-request', content: 'wrong', data: { event_id: 'answer-1' } }), 'data: {broken}\n\n', 'data: {"response_type":"complete","done":true}']) {
    const result = await readAgentStream(stream(wire(query) + suffix + wire({ response_type: 'complete', done: true })), ids.sessionId, async () => {})
    assert.equal(result.status, 'unknown')
  }
  const result = await readAgentStream(stream(wire(query) + wire({ response_type: 'complete', done: true })), ids.sessionId, async () => { throw new Error('DB unavailable') })
  assert.equal(result.status, 'unknown')
})

test('multi-data frames parse and headers-after body stalls are bounded without losing prior text', async () => {
  const first = await readAgentStream(stream(wire(query) + 'event: message\ndata: {"response_type":"answer",\ndata: "content":"two lines","data":{"event_id":"answer-1"}}\n\n' + wire({ response_type: 'complete', done: true })), ids.sessionId, async () => {})
  assert.equal(first.answer, 'two lines')
  assert.equal(first.status, 'completed')
  const controller = new AbortController()
  const stalled = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(wire(query) + wire({ response_type: 'answer', content: 'partial', data: { event_id: 'answer-1' } }))) } })
  const result = await readAgentStream(stalled, ids.sessionId, async () => { controller.abort() }, { signal: controller.signal })
  assert.equal(result.status, 'unknown')
  assert.equal(result.answer, 'partial')
  const oversized = await readAgentStream(stream(wire(query) + wire({ response_type: 'answer', content: 'x'.repeat(1000), data: { event_id: 'answer-1' } })), ids.sessionId, async () => {}, { maxFrameBytes: 500 })
  assert.equal(oversized.status, 'unknown')
})

const binding: ResolvedAgentBinding = {
  id: 'agent', version: '1', connectionId: 'local', connectionVersion: '1', baseUrl: 'http://127.0.0.1:8180/api/v1', apiKey: 'secret"\\quoted',
  remoteAgentId: '11111111-1111-4111-8111-111111111111', knowledgeBaseIds: ['kb'],
  approval: { authorizationVersion: '1', tenantId: '1', effectiveConfigDigest: 'a'.repeat(64), mode: 'smart-reasoning', allowedTools: ['knowledge_search'], credentialCapability: 'chat', kbSelectionMode: 'selected', retrieveKbOnlyWhenMentioned: false, mcpSelectionMode: 'none', skillsSelectionMode: 'none', sandboxEnabled: false, memoryEnabled: false },
}

test('client sends pinned requests, redacts decoded secrets, and replay starts from zero', async t => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const text = wire(query) + wire({ response_type: 'answer', content: `answer ${binding.apiKey}`, data: { event_id: 'answer-1' } }) + wire({ response_type: 'complete', done: true })
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/sessions')) return Response.json({ data: { id: ids.sessionId } })
    if (url.endsWith('/stop')) return Response.json({ success: true })
    return new Response(stream(text), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const client = new WeknoraAgentClient(binding, () => {})
  assert.equal(JSON.stringify(client), '{}')
  const signal = new AbortController().signal
  assert.equal(await client.createSession(signal), ids.sessionId)
  const result = await client.submit(ids.sessionId, 'synthetic', async () => {}, signal)
  assert.equal(result.answer, 'answer [redacted]')
  const replay = await client.observe(ids, async () => {}, signal)
  assert.equal(replay.answer, result.answer)
  assert.equal(replay.status, 'completed')
  assert.deepEqual(await client.stop(ids, signal), { accepted: true })
  const payload = JSON.parse(String(calls[1].init?.body))
  assert.equal(payload.agent_id, binding.remoteAgentId)
  assert.deepEqual(payload.knowledge_base_ids, ['kb'])
  assert.equal(payload.web_search_enabled, false)
  assert.ok(calls.every(call => call.init?.redirect === 'error'))
  assert.match(calls[2].url, /continue-stream\/session-a\?message_id=assistant-a$/)
  assert.equal(calls[2].init?.method, 'GET')
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { message_id: 'assistant-a' })
})

test('revoked authorization and expired replay never create another remote invocation', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 404 }) })
  const client = new WeknoraAgentClient(binding, () => {})
  await assert.rejects(client.observe(ids, async () => {}, new AbortController().signal), /remote_request_unconfirmed/)
  assert.equal(calls, 1)
  const revoked = new WeknoraAgentClient(binding, () => { throw new Error('revoked') })
  await assert.rejects(revoked.createSession(new AbortController().signal), /revoked/)
  assert.equal(calls, 1)
  assert.throws(() => new WeknoraAgentClient({ ...binding, baseUrl: 'http://private.invalid/api/v1' }, () => {}), /unapproved_origin/)
})

test('answer segments follow deployed tool supersession and preserve first-arrival order', async () => {
  // Wire contract: agent_stream_handler.go@1edcd54:179-203,521-564.
  const answer = (eventId: string, content: string) => ({ response_type: 'answer', content, data: { event_id: eventId } })
  const tool = (toolId: string) => ({ response_type: 'tool_call', data: { tool_name: 'knowledge_search', tool_call_id: toolId } })
  const events = [query, answer('preamble', 'Let me search'), tool('t1'),
    answer('preamble', ' stale late delta'), answer('round-2', 'tentative'), tool('t2'),
    answer('final-a', 'Final'), answer('final-b', ' answer'), answer('final-a', '!'),
    tool('t2'), { response_type: 'answer', content: '', done: true, data: { event_id: 'final-a' } },
    { response_type: 'complete', done: true }]
  const completed = await readAgentStream(stream(events.map(wire).join(''), true), ids.sessionId, async () => {})
  assert.equal(completed.status, 'completed')
  assert.equal(completed.answer, 'Final! answer')
  const partial = await readAgentStream(stream(events.slice(0, -1).map(wire).join('')), ids.sessionId, async () => {})
  assert.equal(partial.status, 'unknown')
  assert.equal(partial.answer, 'Final! answer')
  const fallback = await readAgentStream(stream([query, answer('preamble', 'discard'), tool('t1'),
    { response_type: 'answer', content: 'Fallback answer', data: { event_id: 'answer-fallback-1', is_fallback: true } },
    { response_type: 'complete', done: true }].map(wire).join('')), ids.sessionId, async () => {})
  assert.equal(fallback.answer, 'Fallback answer')
  assert.equal(fallback.status, 'completed')
})

test('internal StreamEvent type is not accepted as the deployed response envelope', async () => {
  const { response_type, ...metadata } = query
  let saved = false
  const result = await readAgentStream(stream(wire({ ...metadata, type: response_type }) + wire({ response_type: 'complete', done: true })), ids.sessionId, async () => { saved = true })
  assert.equal(result.status, 'unknown')
  assert.equal(saved, false)
})
