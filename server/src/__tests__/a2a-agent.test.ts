import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { AgentCard, Message, Task } from '@a2a-js/sdk'
import { A2AError, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutionEvent, type RequestContext } from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express'
import express from 'express'
import { createOpenAIReportGenerator, createReferenceReportAgent, referenceReportCard } from '../../../examples/reference-report-agent/index.js'
import { A2AAgentClient, a2aCardSha256 } from '../integrations/a2a-agent.js'
import type { ResolvedA2ABinding } from '../integrations/bindings.js'

const TOKEN = 'synthetic-a2a-bearer-credential'
async function listen(app: express.Express, t: TestContext): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a` }
}

function bindingFor(baseUrl: string, card: AgentCard, apiKey = TOKEN): ResolvedA2ABinding {
  const digest = a2aCardSha256(card)
  return { backend: 'a2a', id: 'report-binding', version: '1', connectionId: 'reference', connectionVersion: '1', baseUrl, apiKey, remoteAgentId: 'report', knowledgeBaseIds: [],
    approval: { authorizationVersion: '1', tenantId: 'tenant', protocolVersion: '0.3.0', cardSha256: digest, effectiveConfigDigest: digest } }
}

async function fixture(t: TestContext, options: {
  changeCard?: (card: AgentCard) => void
  result?: (context: RequestContext) => unknown
  raw?: string | ((request: Record<string, unknown>) => string)
  beforeResult?: () => void
  apiKey?: string
  redirect?: string
} = {}) {
  const app = express(), requests: Array<{ method: string; path: string; authorization?: string }> = []
  const { baseUrl } = await listen(app, t)
  const card = referenceReportCard(baseUrl)
  options.changeCard?.(card)
  const apiKey = options.apiKey ?? TOKEN
  app.use((req, res, next) => {
    requests.push({ method: req.method, path: req.path, authorization: req.headers.authorization })
    if (req.headers.authorization !== `Bearer ${apiKey}`) { res.status(401).end(); return }
    next()
  })
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), {
    async execute(context, events) {
      options.beforeResult?.()
      const value = options.result ? options.result(context) : { kind: 'task', id: context.taskId, contextId: context.contextId,
        status: { state: 'completed' }, artifacts: [{ artifactId: 'artifact-report', parts: [{ kind: 'text', text: 'Synthetic complete report' }] }] }
      events.publish(value as AgentExecutionEvent)
      events.finished()
    },
    async cancelTask() { throw A2AError.unsupportedOperation('tasks/cancel') },
  })
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }))
  app.use('/a2a', express.json(), (req, res, next) => {
    if (options.redirect) { res.redirect(307, options.redirect); return }
    if (options.raw !== undefined) { res.type('application/json').send(typeof options.raw === 'string' ? options.raw : options.raw(req.body)); return }
    next()
  }, jsonRpcHandler({ requestHandler: handler, userBuilder: async () => ({ isAuthenticated: true, userName: 'fixture' }) }))
  const binding = bindingFor(baseUrl, card, apiKey)
  return { binding, card, requests, client: new A2AAgentClient(binding, () => {}) }
}

const input = { input: 'Prepare a synthetic report.', messageId: 'caller-message' }

test('approved SDK task preserves full text and real IDs without pretending capabilities or sources were verified', async t => {
  const fullText = `# Report\n${'完整正文\n'.repeat(30_000)}END-OF-REPORT`
  const f = await fixture(t, { changeCard: card => { card.capabilities.streaming = true; card.capabilities.pushNotifications = true },
    result: context => ({ kind: 'task', id: context.taskId, contextId: context.contextId, status: { state: 'completed' },
      artifacts: [{ artifactId: 'report', parts: [{ kind: 'text', text: fullText }] }] }) })
  const saved: Record<string, string>[] = []
  let dispatched = 0
  const result = await f.client.submit({ ...input, contextId: 'existing-context' }, async ids => { saved.push(ids) }, AbortSignal.timeout(3000), () => { dispatched++ })
  assert.equal(result.status, 'completed')
  assert.equal(result.answer, fullText)
  assert.equal(result.ids?.contextId, 'existing-context')
  assert.match(result.ids?.taskId ?? '', /^[a-z0-9-]+$/)
  assert.deepEqual(saved, [result.ids])
  assert.equal(dispatched, 1)
  assert.deepEqual(result.validation.evidence.verifiedOperations, ['message/send'])
  assert.equal(result.validation.evidence.advertisedCapabilities.streaming, true)
  assert.deepEqual(result.validation.evidence.sources, [])
  assert.deepEqual(result.references, [])
  assert.equal(result.usage, null)
  assert.equal(result.cost, null)
  assert.equal('sessionId' in (result.ids ?? {}), false)
  assert.deepEqual(f.requests.map(request => [request.method, request.path]), [['GET', '/.well-known/agent-card.json'], ['POST', '/a2a']])
  assert.ok(f.requests.every(request => request.authorization === `Bearer ${TOKEN}`))
})

test('card object reordering preserves approval while semantic digest drift prevents dispatch', async t => {
  const f = await fixture(t)
  assert.equal(a2aCardSha256(Object.fromEntries(Object.entries(f.card).reverse())), f.binding.approval.cardSha256)
  f.card.capabilities.streaming = true
  let dispatched = false
  await assert.rejects(f.client.submit(input, async () => {}, AbortSignal.timeout(3000), () => { dispatched = true }), /a2a_preflight_rejected/)
  assert.equal(dispatched, false)
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0)
})

test('approved foreign URLs, mandatory extensions, non-text modes, unsupported auth and skill ambiguity still fail closed', async t => {
  const changes: Array<(card: AgentCard) => void> = [
    card => { card.url = 'http://127.0.0.1:9/a2a' },
    card => { card.additionalInterfaces = [{ transport: 'JSONRPC', url: 'https://foreign.invalid/a2a' }] },
    card => { card.capabilities.extensions = [{ uri: 'https://foreign.invalid/extension', required: true }] },
    card => { card.defaultOutputModes = ['application/octet-stream'] },
    card => { card.security = [{}] },
    card => { card.skills.push({ ...card.skills[0], id: 'unapproved' }) },
    card => { card.protocolVersion = '1.0' },
  ]
  for (const changeCard of changes) {
    const f = await fixture(t, { changeCard })
    let dispatches = 0
    await assert.rejects(f.client.submit(input, async () => {}, AbortSignal.timeout(3000), () => { dispatches++ }), /a2a_preflight_rejected/)
    assert.equal(dispatches, 0)
    assert.equal(f.requests.some(request => request.method === 'POST'), false)
  }
})

test('direct agent Message is an immediate answer, without fabricated context or task identifiers', async t => {
  const message: Message = { kind: 'message', role: 'agent', messageId: 'real-agent-message', parts: [{ kind: 'text', text: 'First ' }, { kind: 'text', text: 'second\n' }] }
  const f = await fixture(t, { result: () => message })
  const result = await f.client.submit(input, async () => {}, AbortSignal.timeout(3000), () => {})
  assert.equal(result.status, 'completed')
  assert.equal(result.answer, 'First second\n')
  assert.equal(result.ids?.messageId, 'real-agent-message')
  assert.equal('taskId' in (result.ids ?? {}), false)
  assert.equal(result.validation.evidence.terminalKind, 'message')
})

test('only completed text Tasks complete; failed is failure and every other task state stays unknown without follow-up', async t => {
  const states: Task['status']['state'][] = ['submitted', 'working', 'input-required', 'auth-required', 'rejected', 'canceled', 'unknown', 'failed', 'completed']
  for (const state of states) {
    const f = await fixture(t, { result: context => ({ kind: 'task', id: context.taskId, contextId: context.contextId, status: { state },
      artifacts: [{ artifactId: 'report', parts: [{ kind: 'text', text: 'Available text' }] }] }) })
    const saved: Record<string, string>[] = []
    const result = await f.client.submit(input, async ids => { saved.push(ids) }, AbortSignal.timeout(3000), () => {})
    assert.equal(result.status, state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'unknown', state)
    assert.equal(saved.length, 1)
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
  }
})

test('terminal status without an artifact, nontext artifacts, ID drift, and persistence failure cannot publish completed output', async t => {
  const results: Array<(context: RequestContext) => unknown> = [
    context => ({ kind: 'task', id: context.taskId, contextId: context.contextId, status: { state: 'completed' } }),
    context => ({ kind: 'task', id: context.taskId, contextId: context.contextId, status: { state: 'completed' }, artifacts: [{ artifactId: 'file', parts: [{ kind: 'file', file: { uri: 'http://127.0.0.1:9/secret' } }] }] }),
    context => ({ kind: 'task', id: context.taskId, contextId: 'foreign-context', status: { state: 'completed' }, artifacts: [{ artifactId: 'text', parts: [{ kind: 'text', text: 'Wrong context' }] }] }),
  ]
  for (const result of results) {
    const f = await fixture(t, { result })
    const observed = await f.client.submit({ ...input, contextId: 'expected-context' }, async () => {}, AbortSignal.timeout(3000), () => {})
    assert.equal(observed.status, 'unknown')
    assert.equal(observed.validation.ok, false)
    assert.equal(f.requests.length, 2)
  }
  const f = await fixture(t)
  const observed = await f.client.submit(input, async () => { throw new Error('synthetic persistence unavailable') }, AbortSignal.timeout(3000), () => {})
  assert.equal(observed.status, 'unknown')
})

test('decoded credential echoes are withheld even when escaped JSON bypasses raw byte matching', async t => {
  const secret = 'secret-"quoted\\credential'
  const f = await fixture(t, { apiKey: secret, result: context => ({ kind: 'task', id: context.taskId, contextId: context.contextId,
    status: { state: 'completed' }, artifacts: [{ artifactId: 'report', parts: [{ kind: 'text', text: `Do not retain ${secret}` }] }] }) })
  let saved = false
  const result = await f.client.submit(input, async () => { saved = true }, AbortSignal.timeout(3000), () => {})
  assert.equal(result.status, 'unknown')
  assert.equal(saved, false)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(result.answer, '')
})

test('malformed envelopes and oversized bodies are unknown after exactly one send, never SDK retries', async t => {
  const rawResponses: Array<string | ((request: Record<string, unknown>) => string)> = [
    '{broken',
    () => JSON.stringify({ jsonrpc: '2.0', id: 999, result: { kind: 'message', role: 'agent', messageId: 'message', parts: [{ kind: 'text', text: 'wrong ID' }] } }),
    request => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'message', role: 'agent', messageId: 'message', parts: [{ kind: 'text', text: 'ambiguous' }] }, error: { code: -32603, message: 'contradiction' } }),
    request => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'task', id: 'task', contextId: 'ctx', status: { state: 'not-a-state' } } }),
    request => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'message', role: 'agent', messageId: 'message', parts: [{ kind: 'text', text: 'x'.repeat(8 * 1024 * 1024) }] } }),
  ]
  for (const raw of rawResponses) {
    const f = await fixture(t, { raw })
    let sent = 0
    const result = await f.client.submit(input, async () => {}, AbortSignal.timeout(3000), () => { sent++ })
    assert.equal(result.status, 'unknown')
    assert.equal(sent, 1)
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
  }
})

test('post-dispatch timeout and redirects remain unknown without another request or resource fetch', async t => {
  const controller = new AbortController()
  // Abort at the observed server dispatch boundary, not after a guessed sleep.
  const stalled = await fixture(t, { beforeResult: () => controller.abort(new DOMException('Synthetic deadline elapsed', 'TimeoutError')) })
  const timed = await stalled.client.submit(input, async () => {}, controller.signal, () => {})
  assert.equal(timed.status, 'unknown')
  assert.equal(stalled.requests.filter(request => request.method === 'POST').length, 1)
  const redirected = await fixture(t, { redirect: 'http://127.0.0.1:9/foreign' })
  const result = await redirected.client.submit(input, async () => {}, AbortSignal.timeout(3000), () => {})
  assert.equal(result.status, 'unknown')
  assert.equal(redirected.requests.length, 2)
})

test('authorization revoked after card retrieval prevents sending and revocation after execution withholds completion', async t => {
  const f = await fixture(t)
  let allowed = true
  const client = new A2AAgentClient(f.binding, () => { if (!allowed) throw new Error('revoked'); if (f.requests.length === 1) allowed = false })
  await assert.rejects(client.submit(input, async () => {}, AbortSignal.timeout(3000), () => {}), /a2a_preflight_rejected/)
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 0)
  const g = await fixture(t)
  let revoked = false
  const after = new A2AAgentClient(g.binding, () => { if (revoked) throw new Error('revoked') })
  const result = await after.submit(input, async () => { revoked = true }, AbortSignal.timeout(3000), () => {})
  assert.equal(result.status, 'unknown')
  assert.equal(result.validation.ok, false)
})

test('independent reference backend authenticates, bounds input and model concurrency, and emits SDK text artifacts', async t => {
  const app = express()
  const { baseUrl } = await listen(app, t)
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let generations = 0
  const reference = createReferenceReportAgent({ baseUrl, apiKey: TOKEN, maxConcurrent: 1, generate: async () => { generations++; entered(); await gate; return 'Independent synthetic report, not live qualification.' } })
  app.use(reference.app)
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(new URL('/.well-known/agent-card.json', baseUrl))).status, 401)
  assert.equal((await fetch(`${baseUrl}?unapproved=1`, { method: 'POST', headers, body: '{}' })).status, 404)
  assert.equal((await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: 'task' } }) })).status, 405)
  assert.equal((await fetch(baseUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'oversized', parts: [{ kind: 'text', text: 'x'.repeat(8001) }] }, configuration: { blocking: true, acceptedOutputModes: ['text/plain'] } } }) })).status, 400)
  assert.equal(generations, 0)
  const binding = bindingFor(baseUrl, reference.card)
  const first = new A2AAgentClient(binding, () => {}).submit(input, async () => {}, AbortSignal.timeout(3000), () => {})
  try {
    await started
    const second = await new A2AAgentClient(binding, () => {}).submit({ ...input, messageId: 'second' }, async () => {}, AbortSignal.timeout(3000), () => {})
    assert.equal(second.status, 'failed')
    assert.equal(generations, 1)
  } finally { release() }
  const completed = await first
  assert.equal(completed.status, 'completed')
  assert.equal(completed.answer, 'Independent synthetic report, not live qualification.')
})

test('real OpenAI implementation records provider usage against only an explicit local synthetic provider, never ambient keys', async t => {
  const app = express()
  const { baseUrl } = await listen(app, t)
  const directory = await mkdtemp(join(tmpdir(), 'cumora-a2a-ledger-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ledgerPath = join(directory, 'usage.jsonl')
  let calls = 0
  app.post('/v1/chat/completions', express.json(), (req, res) => {
    calls++
    assert.equal(req.headers.authorization, 'Bearer explicit-synthetic-provider-key')
    assert.equal(req.body.model, 'explicit-synthetic-model')
    assert.equal(req.body.messages[1].content, 'Synthetic source material')
    res.json({ id: 'synthetic-completion', object: 'chat.completion', created: 1, model: 'explicit-synthetic-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Provider fixture report' } }], usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 } })
  })
  const generate = createOpenAIReportGenerator({ baseURL: new URL('/v1', baseUrl).href, model: 'explicit-synthetic-model', apiKey: 'explicit-synthetic-provider-key', ledgerPath })
  const report = await generate({ input: 'Synthetic source material', taskId: 'task', contextId: 'context', signal: AbortSignal.timeout(3000) })
  assert.equal(report, 'Provider fixture report')
  assert.equal(calls, 1)
  const records = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(records.map(record => record.phase), ['started', 'finished'])
  assert.equal(records[0].callId, records[1].callId)
  assert.equal(records[1].outcome, 'received')
  assert.deepEqual(records[1].usage, { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 })
  assert.equal(records[1].cost, null)
  assert.equal(JSON.stringify(records).includes('explicit-synthetic-provider-key'), false)
  assert.equal(JSON.stringify(records).includes('Synthetic source material'), false)
})
