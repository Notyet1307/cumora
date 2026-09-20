import assert from 'node:assert/strict'
import { EventEmitter, once, on } from 'node:events'
import { after, before, beforeEach, test } from 'node:test'
import type { Response } from 'express'
import { createServer } from 'node:http'
import { pool } from '../db/pool.js'
import { sub, CH_CONVENE } from '../redis.js'
import { createAgentRecord } from '../agents/create.js'
import { wakeAgent } from '../agents/scheduler.js'
import { attachWakeStream } from '../agents/runtime/wake-bus.js'
import { configureExternalExecution, resolveExecution } from '../agents/execution.js'
import { BindingResolver } from '../integrations/bindings.js'
import type { BindingConfig } from '../integrations/bindings.js'
import { InvocationStore } from '../integrations/invocations.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'
import { runAgentTurn } from '../agents/turn.js'
import { ensurePod } from '../agents/runtime/orchestrator.js'
import { isRuntimeAgentAuthorized } from '../agents/runtime/authorization.js'
import { assignAgentToComputer, listAgentsForComputer, mintAgentRuntimeToken, issuePairingCode, setComputerDefaultEngine } from '../agents/computer/registry.js'
import { loadElectionCandidates } from '../agents/routing-claims.js'
import { runIdleTick, __setIdleWakeForTesting, _resetIdleForTests } from '../agents/idle.js'
import { scanOnce, __setBackgroundScannerWakeForTesting, _resetBackgroundScannerForTests } from '../agents/scanner.js'
import { wakeKanbanAgents, __setKanbanWakeAgentForTesting } from '../agents/kanban-wake.js'
import { fanOutWake, handlePollUpdated } from '../agents/scheduler.js'
import { startConvene } from '../agents/convene.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, buildApiTestApp, teardownAll } from './_helpers.js'

const companyId = 'co-execution-test'
const nativeId = 'native-execution-test'
let externalId: string
before(async () => { await ensureSchemaOnce() })
beforeEach(async () => {
  await resetAllTables()
  await seedCompanyWithAgent({ companyId, agentId: nativeId })
  externalId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10,
    name: 'External execution', systemPrompt: 'External only', executionKind: 'external-service' })).id
})
after(async () => { await teardownAll() })

test('[integration] connected runtimes cannot bypass external ownership for any direct wake reason', async () => {
  const output: string[] = []
  const stream = Object.assign(new EventEmitter(), {
    setHeader() {}, flushHeaders() {}, write(chunk: string) { output.push(chunk); return true },
    end(): void { stream.emit('close') },
  })
  await attachWakeStream(externalId, stream as unknown as Response)
  try {
    for (const reason of ['message.new', 'manual', 'idle', 'background_scan', 'poll.updated'] as const) {
      assert.equal(await wakeAgent(externalId, reason, null), false, reason)
    }
    // Barrier on the actual Redis subscriber, rather than a timing-only absence assertion.
    await sub.ping()
    assert.equal(output.some(line => line.includes('event: wake') || line.includes('event: steer')), false)
  } finally { stream.end() }
})

function bindingConfig(subjectId = externalId): BindingConfig {
  return {
    schemaVersion: 1,
    connections: [{ id: 'external', version: '1', kind: 'agent-service', backend: 'weknora',
      baseUrl: 'http://127.0.0.1:1/api/v1', secretRef: 'test', credentialRevision: '1',
      knowledgeBaseIds: ['kb'], enabled: true }],
    bindings: [{ id: 'execution', version: '1', kind: 'agent-service', capabilityId: 'weknora.agent',
      remoteAgentId: '11111111-1111-4111-8111-111111111111', connectionId: 'external', connectionVersion: '1',
      companyIds: [companyId], subjectIds: [subjectId], enabled: true,
      approval: { authorizationVersion: '1', tenantId: '1', effectiveConfigDigest: 'a'.repeat(64),
        mode: 'smart-reasoning', allowedTools: ['knowledge_search'], credentialCapability: 'chat',
        kbSelectionMode: 'selected', retrieveKbOnlyWhenMentioned: false, mcpSelectionMode: 'none',
        skillsSelectionMode: 'none', sandboxEnabled: false, memoryEnabled: false } }],
  }
}

async function assignmentId(id = externalId): Promise<string> {
  return (await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1', [id])).rows[0].runtime_assignment_id
}

test('[integration] external binding authorization fails closed and carries no resource secrets', async () => {
  const actor = { companyId, subjectId: externalId }
  const bindings = new BindingResolver(bindingConfig(), { test: 'not-a-real-secret' })
  const enabled = await configureExternalExecution(actor, { assignmentId: await assignmentId(), enabled: true }, bindings)
  assert.deepEqual(await resolveExecution(actor, bindings), { kind: 'external-service', assignmentId: enabled,
    bindingId: 'execution', bindingVersion: '1', configDigest: 'a'.repeat(64) })
  assert.equal((await resolveExecution({ ...actor, companyId: 'wrong' }, bindings)).kind, 'denied')
  assert.equal((await resolveExecution({ ...actor, subjectId: 'missing' }, bindings)).kind, 'denied')
  assert.equal((await resolveExecution(actor)).kind, 'denied')
  assert.equal((await resolveExecution(actor, new BindingResolver(bindingConfig('other'), { test: 'fake' }))).kind, 'denied')
  const changed = bindingConfig()
  changed.bindings[0].version = '2'
  assert.deepEqual(await resolveExecution(actor, new BindingResolver(changed, { test: 'fake' })),
    { kind: 'denied', code: 'assignment_changed' })
  const drifted = bindingConfig()
  if (drifted.bindings[0].kind === 'agent-service') drifted.bindings[0].approval!.effectiveConfigDigest = 'b'.repeat(64)
  assert.equal((await resolveExecution(actor, new BindingResolver(drifted, { test: 'fake' }))).kind, 'denied')
  assert.deepEqual(await resolveExecution(actor, bindings, { query: async () => { throw new Error('database offline') } }),
    { kind: 'denied', code: 'unavailable' })
  assert.equal((await resolveExecution({ companyId, subjectId: nativeId })).kind, 'native')
})

test('[integration] native hot switching and all external placement shapes are refused', async () => {
  await pool.query(`INSERT INTO computers (id,company_id,name,kind,available_engines,status)
    VALUES ('native-computer',$1,'Native','local','["codex"]','online')`, [companyId])
  assert.equal(await assignAgentToComputer({ agentId: externalId, companyId, computerId: 'native-computer', engine: 'codex' }), null)
  assert.equal(await mintAgentRuntimeToken({ agentId: externalId, computerId: 'native-computer' }), null)
  assert.deepEqual(await listAgentsForComputer('native-computer'), [])
  await assert.rejects(pool.query(`UPDATE participants SET execution_kind='external-service', execution_enabled=FALSE WHERE id=$1`, [nativeId]), /execution_kind is immutable/)
  for (const sql of [
    `UPDATE participants SET computer_id='native-computer' WHERE id=$1`,
    `UPDATE participants SET engine='managed' WHERE id=$1`,
    `UPDATE participants SET provider_profile='work' WHERE id=$1`,
    `UPDATE participants SET execution_enabled=TRUE WHERE id=$1`,
    `UPDATE participants SET execution_binding_id='partial' WHERE id=$1`,
  ]) await assert.rejects(pool.query(sql, [externalId]), /participants_execution_shape/)
  assert.deepEqual((await loadElectionCandidates([externalId, nativeId])).map(row => row.id), [nativeId])
})

test('[integration] enabled external identity cannot obtain a native turn or Pod', async t => {
  const actor = { companyId, subjectId: externalId }
  const bindings = new BindingResolver(bindingConfig(), { test: 'fake' })
  const enabled = await configureExternalExecution(actor, { assignmentId: await assignmentId(), enabled: true }, bindings)
  let networkCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('network forbidden') })
  assert.equal(await inprocClient.loadPersona(externalId), null)
  assert.deepEqual(await inprocClient.loadInbox(externalId), [])
  await runAgentTurn(externalId)
  const pod = await ensurePod(externalId)
  assert.equal(pod.ok, false)
  assert.equal(pod.code, 'placement_denied')
  assert.equal(await isRuntimeAgentAuthorized({ sub: externalId, companyId, computerId: null, assignmentId: enabled }), false)
  assert.equal(networkCalls, 0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE agent_id=$1', [externalId])).rows[0].n, 0)
})

test('[integration] competing ownership mutations rotate once and unknown invocations cannot be bypassed', async () => {
  const actor = { companyId, subjectId: externalId }
  const bindings = new BindingResolver(bindingConfig(), { test: 'fake' })
  const initial = await assignmentId()
  const races = await Promise.allSettled([
    configureExternalExecution(actor, { assignmentId: initial, enabled: true }, bindings),
    configureExternalExecution(actor, { assignmentId: initial, enabled: true }, bindings),
  ])
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1)
  const enabled = await assignmentId()
  assert.notEqual(enabled, initial)
  const store = new InvocationStore(pool)
  const pending = await store.accept(actor, { sourceId: 'pending', query: 'test only', conversationScope: 'test',
    snapshot: { bindingId: 'execution', bindingVersion: '1', connectionId: 'external', connectionVersion: '1',
      authorizationVersion: '1', remoteAgentId: '11111111-1111-4111-8111-111111111111', tenantId: '1',
      knowledgeBaseIds: ['kb'], effectiveConfigDigest: 'a'.repeat(64) } })
  const claimed = await store.claim(actor, pending.id)
  assert.ok(claimed)
  await pool.query(`UPDATE external_invocations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [pending.id])
  await store.expireLeases(actor)
  const disabled = await configureExternalExecution(actor, { assignmentId: enabled, enabled: false })
  assert.notEqual(disabled, enabled)
  assert.equal((await resolveExecution(actor, bindings)).kind, 'denied')
  await assert.rejects(configureExternalExecution(actor, { assignmentId: disabled, enabled: true }, bindings), /external_invocation_pending/)
  assert.equal((await store.get(actor, pending.id))?.status, 'unknown')
  assert.equal(await assignmentId(), disabled)
})

test('[integration] synthetic planning, election recovery, poll and convene never execute an external member', { timeout: 10000 }, async t => {
  await pool.query('UPDATE participants SET departed_at=NOW() WHERE id=$1', [nativeId])
  await pool.query(`UPDATE participants SET tools='["bash","background.scan"]' WHERE id=$1`, [externalId])
  await pool.query(`INSERT INTO conversations (id,company_id,kind,title,members)
    VALUES ('external-room',$1,'group','External only',$2::jsonb)`, [companyId, JSON.stringify([externalId])])
  await pool.query(`INSERT INTO messages (id,company_id,conversation_id,author_id,kind,body,sequence)
    VALUES ('external-poll',$1,'external-room',$2,'text','Question',1)`, [companyId, externalId])
  let nativeWakes = 0
  let networkCalls = 0
  __setIdleWakeForTesting(async () => { nativeWakes++; return true })
  __setBackgroundScannerWakeForTesting(async () => { nativeWakes++; return true })
  __setKanbanWakeAgentForTesting(async () => { nativeWakes++ })
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('network forbidden') })
  const events = on(sub, 'message')
  await sub.subscribe(CH_CONVENE)
  try {
    await runIdleTick()
    await scanOnce()
    await wakeKanbanAgents({ companyId, mentions: [externalId], actorId: nativeId,
      card: { boardId: 'board', cardId: 'card', what: 'assigned' } })
    assert.deepEqual(await loadElectionCandidates([externalId]), [])
    await fanOutWake([externalId], 'external-room', null)
    assert.equal(await handlePollUpdated({ type: 'poll.updated', companyId, conversationId: 'external-room',
      messageId: 'external-poll', actorId: null, tallies: [],
      poll: { question: 'Question', mode: 'single', options: [], expiresAt: null, closedAt: null, closedReason: null } }), false)
    await startConvene({ companyId, conversationId: 'external-room', startedBy: externalId, topic: 'No native execution' })
    for await (const [channel, raw] of events) {
      if (channel === CH_CONVENE && JSON.parse(raw).kind === 'ended') break
    }
    assert.equal(nativeWakes, 0)
    assert.equal(networkCalls, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM convene_transcript WHERE author_id=$1', [externalId])).rows[0].n, 0)
  } finally {
    await events.return?.()
    await sub.unsubscribe(CH_CONVENE)
    _resetIdleForTests()
    __setKanbanWakeAgentForTesting(null)
    await _resetBackgroundScannerForTests()
  }
})

test('[integration] public pairing repair, default engines and rehire cannot adopt or enable external members', async () => {
  const ownerId = 'owner-execution-test'
  await seedUserMembership(ownerId, companyId)
  await pool.query('UPDATE companies SET owner_user_id=$2 WHERE id=$1', [companyId, ownerId])
  const server = createServer(await buildApiTestApp(ownerId)).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}/api`
  const headers = { 'content-type': 'application/json', 'x-company-id': companyId }
  try {
    const { code } = await issuePairingCode({ companyId, ownerUserId: ownerId })
    const response = await fetch(`${base}/computers/pair`, { method: 'POST', headers,
      body: JSON.stringify({ code, hostName: 'isolated-test-host', engines: ['codex','claude'] }) })
    assert.equal(response.status, 200)
    const paired = await response.json() as { computerId: string }
    const roster = await listAgentsForComputer(paired.computerId)
    assert.equal(roster.some(member => member.id === externalId), false)
    assert.equal(roster.some(member => member.id === nativeId), true)
    await setComputerDefaultEngine({ companyId, computerId: paired.computerId, engine: 'claude' })
    const external = (await pool.query('SELECT computer_id,engine FROM participants WHERE id=$1', [externalId])).rows[0]
    assert.deepEqual(external, { computer_id: null, engine: null })
    const assigned = await fetch(`${base}/agents/${externalId}/computer`, { method: 'POST', headers,
      body: JSON.stringify({ computerId: paired.computerId, engine: 'codex' }) })
    assert.equal(assigned.status, 400)
    await assigned.body?.cancel()
    const actor = { companyId, subjectId: externalId }
    const bindings = new BindingResolver(bindingConfig(), { test: 'fake' })
    await configureExternalExecution(actor, { assignmentId: await assignmentId(), enabled: true }, bindings)
    await pool.query('UPDATE participants SET departed_at=NOW() WHERE id=$1', [externalId])
    const rehired = await fetch(`${base}/agents/${externalId}/rehire`, { method: 'POST', headers })
    assert.equal(rehired.status, 200)
    await rehired.body?.cancel()
    assert.deepEqual(await resolveExecution(actor, bindings), { kind: 'denied', code: 'disabled' })
  } finally {
    server.close()
    server.closeAllConnections()
    await once(server, 'close')
  }
})
