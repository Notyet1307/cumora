import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import type { ArtifactContent, ArtifactHandoff, ArtifactView } from '../../../shared/external-artifacts.js'
import type { CliResult } from '../agents/cli-result.js'
import { createAgentRecord } from '../agents/create.js'
import { configureExternalExecution } from '../agents/execution.js'
import { signAgentToken } from '../agents/runtime/jwt.js'
import { runtimeRouter } from '../agents/runtime/server.js'
import { __setArtifactWakeForTesting } from '../api/external-artifact-router.js'
import { pool } from '../db/pool.js'
import { ArtifactService } from '../integrations/artifacts.js'
import { BindingResolver } from '../integrations/bindings.js'
import { MemberAgent, installMemberAgent } from '../integrations/member-agent.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'
import { ExternalAgentFixture, FIXTURE_ANSWER } from './external-agent-fixture.js'

const companyId = 'c-artifact-test'
const userId = 'u-artifact-test'
const room = 'dm-artifact-test'
const actor = { companyId, subjectId: userId }
let server: Server
let origin: string
let fixture: ExternalAgentFixture
let member: MemberAgent
let externalId: string
let reporterId: string
let otherId: string
let reporterToken: string
let otherToken: string
const wakes: string[] = []
const service = new ArtifactService(pool)

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(userId)
  app.use('/runtime', runtimeRouter)
  server = createServer(app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  __setArtifactWakeForTesting(async (id, brief) => {
    assert.equal(brief.source, 'external-artifact')
    assert.match(brief.body, /cumora artifact read/)
    assert.doesNotMatch(brief.body, /PRIVATE INSTRUCTIONS|SECRET INPUT/)
    wakes.push(id)
  })
})
beforeEach(async () => {
  await resetAllTables()
  wakes.length = 0
  fixture = new ExternalAgentFixture()
  await fixture.start()
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Artifact test','artifact-test',$2)", [companyId, userId])
  await seedUserMembership(userId, companyId)
  externalId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10, name: 'Artifact source', systemPrompt: 'External only', executionKind: 'external-service' })).id
  const bindings = new BindingResolver(fixture.config(companyId, externalId), { 'fixture-chat': 'fixture-chat-only' })
  const assignment = (await pool.query<{ runtime_assignment_id: string }>('SELECT runtime_assignment_id FROM participants WHERE id=$1 AND company_id=$2', [externalId, companyId])).rows[0].runtime_assignment_id
  await configureExternalExecution({ companyId, subjectId: externalId }, { assignmentId: assignment, enabled: true }, bindings)
  await pool.query('INSERT INTO conversations(id,kind,title,members,company_id) VALUES($1,\'direct\',\'Private source\',$2::jsonb,$3)', [room, JSON.stringify([userId, externalId]), companyId])
  reporterId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10, name: 'Synthetic reporter', systemPrompt: 'Fixture only' })).id
  otherId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10, name: 'Unauthorized reporter', systemPrompt: 'Fixture only' })).id
  reporterToken = await token(reporterId)
  otherToken = await token(otherId)
  member = new MemberAgent(pool, bindings)
  installMemberAgent(member)
})
afterEach(async () => { await member.stop(); await fixture.close() })
after(async () => { __setArtifactWakeForTesting(null); await teardownAll(server) })

async function token(id: string): Promise<string> {
  const row = (await pool.query<{ computer_id: string | null; runtime_assignment_id: string }>('SELECT computer_id,runtime_assignment_id FROM participants WHERE company_id=$1 AND id=$2', [companyId, id])).rows[0]
  return signAgentToken({ agentId: id, companyId, computerId: row.computer_id, assignmentId: row.runtime_assignment_id })
}
async function request<T>(path: string, body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': companyId, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, value: await response.json() as T }
}
async function native(jwt: string, argv: string[]) {
  const response = await fetch(`${origin}/runtime/cli`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ argv }) })
  return { status: response.status, value: await response.json() as CliResult }
}
async function completedDelivery(input = 'SECRET INPUT: synthetic compliance question'): Promise<string> {
  const posted = await request<{ id: string }>(`/conversations/${room}/messages`, { body: input })
  assert.equal(posted.status, 202)
  await member.drain()
  const row = (await pool.query<{ id: string; status: string }>('SELECT id,status FROM external_message_deliveries WHERE source_message_id=$1', [posted.value.id])).rows[0]
  assert.equal(row.status, 'completed')
  return row.id
}
async function capture(input?: string): Promise<ArtifactView> {
  const result = await request<ArtifactView>('/external-artifacts', { deliveryId: await completedDelivery(input), title: 'Fixed compliance evidence' })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  return result.value
}
async function handoff(artifact: ArtifactView, requestId = randomUUID()): Promise<ArtifactHandoff> {
  const result = await request<ArtifactHandoff>(`/external-artifacts/${artifact.id}/handoffs`, {
    version: artifact.latestVersion, expectedRevision: artifact.inputRevision, assigneeId: reporterId,
    instructions: 'PRIVATE INSTRUCTIONS: produce a synthetic report; retain limitations.', requestId,
  })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  return result.value
}
async function readNative(artifact: ArtifactView, version = 1, jwt = reporterToken) {
  return native(jwt, ['artifact', 'read', artifact.id, String(version)])
}

// These are real HTTP/JWT/CLI operations against a synthetic upstream, not a model-quality test.
test('fixed full evidence -> one explicit native task -> immutable draft -> human approval', async () => {
  const deliveryId = await completedDelivery()
  const [saved, replay] = await Promise.all([
    request<ArtifactView>('/external-artifacts', { deliveryId, title: 'Fixed evidence' }),
    request<ArtifactView>('/external-artifacts', { deliveryId, title: 'Fixed evidence' }),
  ])
  assert.equal(saved.status, 200, JSON.stringify(saved.value))
  assert.equal(replay.status, 200)
  assert.equal(saved.value.id, replay.value.id)
  const artifact = saved.value
  assert.equal((await readNative(artifact)).value.ok, false)
  const source = await request<ArtifactContent>(`/external-artifacts/${artifact.id}/versions/1`)
  assert.equal(source.value.body, FIXTURE_ANSWER.replace(/<kb[^>]+\/>/, '[1]'))
  assert.equal(source.value.citations[0].title, '合成审查规范 · 第 39 条')
  const requestId = randomUUID()
  const [assigned, assignedReplay] = await Promise.all([handoff(artifact, requestId), handoff(artifact, requestId)])
  assert.equal(assigned.id, assignedReplay.id)
  assert.deepEqual(wakes, [reporterId])
  const received = await readNative(artifact)
  assert.equal(received.value.ok, true, received.value.text)
  assert.deepEqual(JSON.parse(received.value.text), source.value)
  assert.equal((await readNative(artifact, 1, otherToken)).value.ok, false)
  assert.equal((await native(reporterToken, ['kb', 'search', 'synthetic access check'])).value.ok, false)
  assert.equal((await pool.query('SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND participant_id=$2', [room, reporterId])).rowCount, 0)
  const draft = 'SYNTHETIC REPORT — requires human review.\n' + 'Complete report paragraph; no legal approval claimed.\n'.repeat(180)
  const first = await native(reporterToken, ['artifact', 'submit', assigned.id, draft])
  assert.equal(first.value.ok, true, first.value.text)
  const output = JSON.parse(first.value.text) as ArtifactContent
  assert.equal(output.body, draft)
  const duplicate = await native(reporterToken, ['artifact', 'submit', assigned.id, draft])
  assert.equal(duplicate.value.ok, true)
  assert.equal((JSON.parse(duplicate.value.text) as ArtifactContent).version, output.version)
  assert.equal((await native(reporterToken, ['artifact', 'submit', assigned.id, 'different report'])).value.ok, false)
  await native(reporterToken, ['tasks', 'set', assigned.taskId, 'done'])
  assert.equal((await service.read(actor, artifact.id)).handoffs[0].status, 'submitted')
  await assert.rejects(service.review({ companyId, subjectId: reporterId }, artifact.id, assigned.id, { outputVersion: output.version, decision: 'accepted', note: 'self approval' }))
  assert.equal((await native(reporterToken, ['artifact', 'review', assigned.id, 'accepted', '--as', userId])).value.ok, false)
  const accepted = await request<ArtifactView>(`/external-artifacts/${artifact.id}/handoffs/${assigned.id}/review`, { outputVersion: output.version, decision: 'accepted', note: 'Synthetic human fixture confirms this fixed draft.' })
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value))
  assert.equal(accepted.value.handoffs[0].status, 'accepted')
  assert.equal((await new ArtifactService(pool).readVersion(actor, artifact.id, 1)).body, source.value.body)
  assert.equal(fixture.requests.filter(r => r.path.includes('/agent-chat/')).length, 1)
})

test('input revisions stale pending work, reject late output, and require a matching new external answer', async () => {
  const artifact = await capture('original synthetic question')
  const assigned = await handoff(artifact)
  const revised = await request<ArtifactView>(`/external-artifacts/${artifact.id}/revise`, { expectedRevision: 1, inputText: 'revised synthetic question' })
  assert.equal(revised.status, 200)
  assert.equal(revised.value.inputRevision, 2)
  assert.equal(revised.value.versions[0].stale, true)
  assert.equal(revised.value.handoffs[0].status, 'stale')
  assert.equal((await native(reporterToken, ['artifact', 'submit', assigned.id, 'late old report'])).value.ok, false)
  assert.equal((await readNative(artifact)).value.ok, false)
  assert.equal((await request(`/external-artifacts/${artifact.id}/revise`, { expectedRevision: 1, inputText: 'lost update' })).status, 409)
  const mismatched = await completedDelivery('unrelated question')
  assert.equal((await request('/external-artifacts', { deliveryId: mismatched, artifactId: artifact.id, expectedRevision: 2 })).status, 409)
  const next = await request<ArtifactView>('/external-artifacts', { deliveryId: await completedDelivery('revised synthetic question'), artifactId: artifact.id, expectedRevision: 2 })
  assert.equal(next.status, 200, JSON.stringify(next.value))
  const old = await service.readVersion(actor, artifact.id, 1)
  assert.equal(old.inputText, 'original synthetic question')
  assert.equal(old.stale, true)
  assert.equal((await service.readVersion(actor, artifact.id, next.value.latestVersion)).inputText, 'revised synthetic question')
  const newHandoff = await handoff(next.value)
  assert.notEqual(newHandoff.id, assigned.id)
  assert.equal((await readNative(next.value, next.value.latestVersion)).value.ok, true)
  assert.equal((await readNative(artifact)).value.ok, false)
})

test('cancellation revokes access and submission; neither retries nor unrelated actors can widen the grant', async () => {
  const artifact = await capture()
  const id = randomUUID()
  const assigned = await handoff(artifact, id)
  const conflict = await request(`/external-artifacts/${artifact.id}/handoffs`, { version: 1, expectedRevision: 1, assigneeId: otherId, instructions: 'changed recipient', requestId: id })
  assert.equal(conflict.status, 409)
  const cancelled = await request<ArtifactView>(`/external-artifacts/${artifact.id}/handoffs/${assigned.id}/cancel`, {})
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.value.handoffs[0].status, 'cancelled')
  assert.equal((await readNative(artifact)).value.ok, false)
  assert.equal((await native(reporterToken, ['artifact', 'submit', assigned.id, 'late cancelled report'])).value.ok, false)
  await seedUserMembership('u-other-human', companyId)
  await assert.rejects(service.read({ companyId, subjectId: 'u-other-human' }, artifact.id))
  await assert.rejects(service.readVersion({ companyId: 'foreign-company', subjectId: userId }, artifact.id, 1))
  const unauthorized = await native(otherToken, ['artifact', 'read', artifact.id, '1', '--as', reporterId])
  assert.equal(unauthorized.value.ok, false)
  const count = fixture.requests.length
  await handoff(artifact)
  await handoff(artifact)
  const overLimit = await request(`/external-artifacts/${artifact.id}/handoffs`, { version: 1, expectedRevision: 1, assigneeId: reporterId, instructions: 'fourth task', requestId: randomUUID() })
  assert.equal(overLimit.status, 409)
  assert.equal(fixture.requests.length, count)
})

test('reserved storage is immutable and cannot be read through generic CLI, filesystem, or devtools', async () => {
  const artifact = await capture()
  const path = `external-artifacts/${artifact.id}/1.json`
  const row = await pool.query<{ body: string }>('SELECT body FROM agent_workspace WHERE agent_id=$1 AND path=$2', [externalId, path])
  assert.ok(row.rows[0])
  await assert.rejects(pool.query('UPDATE agent_workspace SET body=$3 WHERE agent_id=$1 AND path=$2', [externalId, path, 'overwritten']))
  await assert.rejects(pool.query('DELETE FROM agent_workspace WHERE agent_id=$1 AND path=$2', [externalId, path]))
  for (const args of [['read', path], ['write', path, 'malicious'], ['edit', path, 'body', 'bad'], ['delete', path]]) {
    assert.equal((await native(reporterToken, ['workspace', ...args])).value.ok, false)
  }
  const fs = await fetch(`${origin}/runtime/fs/read?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${reporterToken}` } })
  assert.equal(fs.status, 404)
  const dev = await request(`/devtools/agent-workspace/file?agentId=${externalId}&path=${encodeURIComponent(path)}`, undefined, { 'x-cumora-dev-mode': '1' })
  assert.ok([403, 404].includes(dev.status))
  assert.equal((await service.readVersion(actor, artifact.id, 1)).body, FIXTURE_ANSWER.replace(/<kb[^>]+\/>/, '[1]'))
})

test('assignment changes and source membership loss invalidate already-issued read grants', async () => {
  const artifact = await capture()
  await handoff(artifact)
  await pool.query('UPDATE participants SET runtime_assignment_id=$3 WHERE company_id=$1 AND id=$2', [companyId, reporterId, randomUUID()])
  assert.equal((await readNative(artifact)).status, 403)
  const newToken = await token(reporterId)
  assert.equal((await readNative(artifact, 1, newToken)).value.ok, false)
  await pool.query('DELETE FROM conversation_members WHERE company_id=$1 AND conversation_id=$2 AND participant_id=$3', [companyId, room, userId])
  assert.equal((await request(`/external-artifacts/${artifact.id}/versions/1`)).status, 403)
  assert.deepEqual(await service.list(actor), [])
})

test('uncompleted or malformed capture cannot manufacture trusted content or trigger resubmission', async () => {
  for (const body of [null, {}, { deliveryId: 42 }, { deliveryId: 'not-real', answer: 'fabricated approval' }]) {
    const result = await request('/external-artifacts', body)
    assert.ok(result.status >= 400 && result.status < 500, `unexpected status ${result.status}`)
  }
  fixture.mode = 'unknown'
  const message = await request<{ id: string }>(`/conversations/${room}/messages`, { body: 'unknown synthetic request' })
  await member.drain()
  const delivery = (await pool.query<{ id: string }>('SELECT id FROM external_message_deliveries WHERE source_message_id=$1', [message.value.id])).rows[0]
  const saved = await request('/external-artifacts', { deliveryId: delivery.id })
  assert.ok(saved.status >= 400 && saved.status < 500)
  await member.drain()
  assert.equal(fixture.requests.filter(r => r.path.includes('/agent-chat/')).length, 1)
})

test('expiration removes content, not identity fences, and never resubmits the external request', async () => {
  const artifact = await capture()
  const assigned = await handoff(artifact)
  await pool.query("UPDATE external_artifacts SET content_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [artifact.id])
  assert.equal((await request(`/external-artifacts/${artifact.id}/versions/1`)).status, 410)
  assert.equal((await native(reporterToken, ['artifact', 'submit', assigned.id, 'late expired report'])).value.ok, false)
  const { runDbGcTick } = await import('../db-gc.js')
  await runDbGcTick()
  const expired = await service.read(actor, artifact.id)
  assert.equal(expired.expired, true)
  assert.equal(expired.inputText, '')
  assert.equal(expired.handoffs[0].instructions, '')
  assert.equal(expired.versions[0].sha256, artifact.versions[0].sha256)
  assert.equal((await pool.query('SELECT 1 FROM agent_workspace WHERE agent_id=$1 AND path=$2', [externalId, `external-artifacts/${artifact.id}/1.json`])).rowCount, 0)
  assert.equal((await request('/external-artifacts', { deliveryId: artifact.versions[0].sourceDeliveryId })).status, 410)
  await member.drain()
  assert.equal(fixture.requests.filter(r => r.path.includes('/agent-chat/')).length, 1)
})

test('cancel and draft submission serialize without accepting a late result', async () => {
  const artifact = await capture()
  const assigned = await handoff(artifact)
  const [, cancelled] = await Promise.all([
    native(reporterToken, ['artifact', 'submit', assigned.id, 'racing draft']),
    request<ArtifactView>(`/external-artifacts/${artifact.id}/handoffs/${assigned.id}/cancel`, {}),
  ])
  assert.equal(cancelled.status, 200)
  const state = await service.read(actor, artifact.id)
  assert.equal(state.handoffs[0].status, 'cancelled')
  assert.equal((await readNative(artifact)).value.ok, false)
  const reviewed = await request(`/external-artifacts/${artifact.id}/handoffs/${assigned.id}/review`, {
    outputVersion: state.handoffs[0].outputVersion ?? 2, decision: 'accepted', note: 'cannot accept cancelled work',
  })
  assert.equal(reviewed.status, 409)
})

test('human account suspension revokes delegated evidence access', async () => {
  const artifact = await capture()
  await handoff(artifact)
  await pool.query('UPDATE users SET suspended_at=NOW() WHERE id=$1', [userId])
  assert.equal((await readNative(artifact)).value.ok, false)
  await assert.rejects(service.readVersion(actor, artifact.id, 1))
})

test('authorized workspace deletion removes private artifact bodies and metadata without orphaning records', async () => {
  const artifact = await capture()
  await handoff(artifact)
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES('c-artifact-alternative','Alternative','artifact-alternative',$1)", [userId])
  await seedUserMembership(userId, 'c-artifact-alternative')
  const response = await fetch(`${origin}/api/companies/${companyId}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', 'x-company-id': companyId },
    body: JSON.stringify({ confirmation: 'Artifact test' }),
  })
  assert.equal(response.status, 200, await response.text())
  assert.equal((await pool.query('SELECT 1 FROM agent_workspace WHERE agent_id=$1', [externalId])).rowCount, 0)
  assert.equal((await pool.query('SELECT 1 FROM external_artifacts WHERE id=$1', [artifact.id])).rowCount, 0)
  assert.equal((await pool.query('SELECT 1 FROM external_artifact_handoffs WHERE artifact_id=$1', [artifact.id])).rowCount, 0)
  await assert.rejects(service.read(actor, artifact.id))
})
