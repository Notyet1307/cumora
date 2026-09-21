import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import express from 'express'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createAgentRecord } from '../agents/create.js'
import { isRuntimeAgentAuthorized } from '../agents/runtime/authorization.js'
import { McpToolDispatcher } from '../integrations/mcp-tools.js'
import type { IntegrationManagementView } from '../../../src/integration-types.js'
import { createReferenceReportAgent } from '../../../examples/reference-report-agent/index.js'
import { pool } from '../db/pool.js'
import { a2aCardSha256 } from '../integrations/a2a-agent.js'
import { IntegrationManagement, installIntegrationManagement, type IntegrationTrustGrant } from '../integrations/management.js'
import { MemberAgent, installMemberAgent } from '../integrations/member-agent.js'
import type { BindingConfig } from '../integrations/bindings.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const company = 'c-e5-test', user = 'u-e5-test', secret = 'e5-test-private-credential'
let server: Server, remote: Server, origin: string, remoteUrl: string, digest: string
let management: IntegrationManagement, member: MemberAgent, memberId: string, calls = 0
let beforeGenerate: (() => Promise<void>) | undefined
let grants: IntegrationTrustGrant[]

async function listen(app: express.Express) {
  const server = createServer(app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, origin: `http://127.0.0.1:${address.port}` }
}
async function request(method: string, path: string, body?: unknown, tenant = company) {
  const res = await fetch(origin + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-company-id': tenant },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
function config(): BindingConfig {
  return { schemaVersion: 1, connections: [{ id: 'report', version: 'draft', backend: 'a2a', kind: 'agent-service',
    baseUrl: remoteUrl, secretRef: 'report-key', credentialRevision: '1', knowledgeBaseIds: [], enabled: true }],
  bindings: [{ id: 'report-binding', version: 'draft', connectionId: 'report', connectionVersion: 'draft', companyIds: [company],
    subjectIds: [memberId], enabled: true, kind: 'agent-service', capabilityId: 'a2a.agent', remoteAgentId: 'report',
    approval: { authorizationVersion: 'draft', tenantId: 'synthetic', effectiveConfigDigest: digest, cardSha256: digest, protocolVersion: '0.3.0' } }] }
}
async function room() {
  const id = 'dm-' + randomUUID()
  await pool.query("INSERT INTO conversations(id,company_id,kind,title,members) VALUES($1,$2,'direct','E5 fixture',$3::jsonb)", [id, company, JSON.stringify([user, memberId])])
  return id
}
async function send(roomId: string) {
  const sent = await request('POST', `/conversations/${roomId}/messages`, { body: 'Synthetic E5 input', clientId: randomUUID() })
  assert.equal(sent.status, 202)
  return sent.body.id as string
}
async function delivery(source: string) {
  return (await pool.query('SELECT * FROM external_message_deliveries WHERE source_message_id=$1', [source])).rows[0]
}
before(async () => {
  await ensureSchemaOnce()
  const app = express()
  const remoteServer = await listen(app)
  remote = remoteServer.server; remoteUrl = remoteServer.origin + '/a2a'
  const reference = createReferenceReportAgent({ baseUrl: remoteUrl, apiKey: secret, generate: async ({ input }) => {
    calls++; await beforeGenerate?.(); return `Complete synthetic answer: ${input}`
  } })
  app.use(reference.app)
  digest = a2aCardSha256(reference.card)
  grants = [{ secretRef: 'report-key', credentialRevision: '1', value: secret, companyIds: [company], backend: 'a2a',
    baseUrls: [remoteUrl], knowledgeBaseIds: [], remoteAgentIds: ['report'], toolNames: [] }]
  const listening = await listen(await buildApiTestApp(user))
  server = listening.server; origin = listening.origin
})
beforeEach(async () => {
  await resetAllTables()
  calls = 0; beforeGenerate = undefined
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'E5 fixture','e5-fixture',$2)", [company, user])
  await seedUserMembership(user, company)
  management = new IntegrationManagement(pool, grants)
  installIntegrationManagement(management)
  memberId = (await management.createMember(company, user, 'External report', randomUUID())).id
  member = new MemberAgent(pool, (actor, db) => management.resolver(actor, db))
  installMemberAgent(member)
})
after(async () => {
  remote.closeAllConnections()
  await new Promise<void>(resolve => remote.close(() => resolve()))
  await teardownAll(server)
})

test('management rejects cross-tenant, ordinary-member and untrusted target changes without leaking credentials', async () => {
  assert.equal((await request('GET', '/integrations', undefined, 'foreign-space')).status, 403)
  await pool.query("UPDATE company_members SET role='member' WHERE company_id=$1 AND user_id=$2", [company, user])
  assert.equal((await request('PUT', '/integrations', { expectedRevision: 0, config: config() })).status, 403)
  await pool.query("UPDATE company_members SET role='owner' WHERE company_id=$1 AND user_id=$2", [company, user])
  const original = await management.view(company, user)
  for (const mutate of [
    (c: BindingConfig) => { c.connections[0].baseUrl = 'http://127.0.0.1:9/a2a' },
    (c: BindingConfig) => { c.connections[0].secretRef = 'another-company-secret' },
    (c: BindingConfig) => { c.bindings[0].companyIds = ['foreign-space'] },
    (c: BindingConfig) => { c.bindings[0].subjectIds = [user] },
    (c: BindingConfig) => { c.connections[0].knowledgeBaseIds = ['outside-grant'] },
  ]) {
    const candidate = config(); mutate(candidate)
    assert.equal((await request('PUT', '/integrations', { expectedRevision: original.revision, config: candidate })).status, 400)
  }
  const saved = await request('PUT', '/integrations', { expectedRevision: original.revision, config: config() })
  assert.equal(saved.status, 200)
  assert.equal(JSON.stringify(saved.body).includes(secret), false)
  assert.equal(JSON.stringify((await request('GET', '/integrations/export')).body).includes(secret), false)
  const checked = await request('POST', '/integrations/test', { revision: saved.body.revision, bindingId: 'report-binding' })
  assert.equal(checked.status, 200)
  assert.equal(checked.body.connectivity, 'pass')
  assert.equal(checked.body.business, 'not_verified')
  assert.equal(checked.body.authentication, 'not_verified')
  assert.equal(calls, 0)
  await pool.query('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2', [company, user])
  assert.equal((await request('GET', '/integrations')).status, 403)
})

test('independent runtime instances observe DB revisions and disabling blocks in-flight publication without replay', async () => {
  const initial = await management.view(company, user)
  const saved = await management.save(company, user, initial.revision, config())
  const secondManagement = new IntegrationManagement(pool, grants)
  const second = new MemberAgent(pool, (actor, db) => secondManagement.resolver(actor, db))
  const roomId = await room()
  const first = await send(roomId)
  await second.drain()
  assert.equal((await delivery(first)).status, 'completed')
  assert.equal(calls, 1)
  const next = await send(roomId)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  beforeGenerate = async () => { entered(); await gate }
  const running = second.drain()
  try {
    await Promise.race([started, running.then(() => { throw new Error('fixture did not start') })])
    const before = await delivery(next)
    const disabled = structuredClone(saved.config); disabled.connections[0].enabled = false
    await management.save(company, user, saved.revision, disabled)
    assert.deepEqual((await delivery(next)).snapshot, before.snapshot)
  } finally { release(); await running }
  assert.equal((await delivery(next)).status, 'blocked_unknown')
  assert.equal(calls, 2)
  await member.drain(); await second.drain()
  assert.equal(calls, 2)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE external_delivery_id=$1', [(await delivery(next)).id])).rows[0].n, 0)
})

test('CAS, failed writes and rollback preserve revision history and unknown execution identity', async () => {
  const initial = await management.view(company, user)
  const attempts = await Promise.allSettled([
    management.save(company, user, initial.revision, config()), management.save(company, user, initial.revision, config()),
  ])
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1)
  let current = await management.view(company, user)
  const enabledRevision = current.revision
  const assignment = (await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1', [memberId])).rows[0].runtime_assignment_id
  await pool.query(`CREATE FUNCTION e5_write_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write fault'; END $$`)
  await pool.query(`CREATE TRIGGER e5_write_fault BEFORE UPDATE ON participants FOR EACH ROW EXECUTE FUNCTION e5_write_fault()`)
  try {
    const disabled = structuredClone(current.config); disabled.connections[0].enabled = false
    await assert.rejects(management.save(company, user, current.revision, disabled))
  } finally {
    await pool.query('DROP TRIGGER e5_write_fault ON participants'); await pool.query('DROP FUNCTION e5_write_fault()')
  }
  assert.deepEqual(await management.view(company, user), current)
  assert.equal((await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1', [memberId])).rows[0].runtime_assignment_id, assignment)
  const disabled = structuredClone(current.config); disabled.connections[0].enabled = false
  current = await management.save(company, user, current.revision, disabled)
  current = await management.rollback(company, user, current.revision, enabledRevision)
  assert.ok(current.revision > enabledRevision)
  assert.notEqual(current.config.bindings[0].version, `r${enabledRevision}`)
  const source = await send(await room())
  await member.drain()
  const delivered = await delivery(source)
  await pool.query("UPDATE external_invocations SET status='unknown',lease_expires_at=NULL WHERE id=$1", [delivered.invocation_id])
  const original = (await pool.query('SELECT snapshot,remote_ids FROM external_invocations WHERE id=$1', [delivered.invocation_id])).rows[0]
  const off = structuredClone(current.config); off.connections[0].enabled = false
  current = await management.save(company, user, current.revision, off)
  await assert.rejects(management.rollback(company, user, current.revision, enabledRevision))
  assert.deepEqual((await pool.query('SELECT snapshot,remote_ids FROM external_invocations WHERE id=$1', [delivered.invocation_id])).rows[0], original)
  assert.equal(calls, 1)
})

test('DB revocation during MCP discovery fences old runtime claims without invoking tools or changing native placement', { timeout: 15_000 }, async (t) => {
  const native = await createAgentRecord({ companyId: company, tier: 'free', maxActiveAgents: 10, name: 'MCP native', systemPrompt: 'Fixture' })
  const before = (await pool.query('SELECT execution_kind,execution_enabled,engine,computer_id FROM participants WHERE id=$1', [native.id])).rows[0]
  const schema = { type: 'object' as const, properties: { asset: { type: 'string' } }, required: ['asset'], additionalProperties: false }
  let revoke = false, toolCalls = 0
  const app = express(); app.use(express.json())
  let current: IntegrationManagementView
  app.all('/mcp', async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`)
    const sdk = new McpServer({ name: 'E5 test', version: '1' }, { capabilities: { tools: {} } })
    sdk.setRequestHandler(ListToolsRequestSchema, async () => {
      if (revoke) {
        const disabled = structuredClone(current.config); disabled.connections[0].enabled = false
        current = await management.save(company, user, current.revision, disabled)
      }
      return { tools: [{ name: 'lookup_asset', inputSchema: schema, annotations: { readOnlyHint: true } }] }
    })
    sdk.setRequestHandler(CallToolRequestSchema, async () => { toolCalls++; return { content: [{ type: 'text', text: 'unexpected' }] } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void sdk.close() })
    await sdk.connect(transport); await transport.handleRequest(req, res, req.body)
  })
  const fixture = await listen(app)
  t.after(() => { fixture.server.closeAllConnections(); fixture.server.close() })
  management = new IntegrationManagement(pool, [...grants, { secretRef: 'mcp-key', credentialRevision: '1', value: secret,
    companyIds: [company], backend: 'mcp', baseUrls: [fixture.origin + '/mcp'], knowledgeBaseIds: [], remoteAgentIds: [], toolNames: ['lookup_asset'] }])
  current = await management.save(company, user, 0, { schemaVersion: 1,
    connections: [{ id: 'tools', version: 'draft', backend: 'mcp', kind: 'tool', baseUrl: fixture.origin + '/mcp',
      secretRef: 'mcp-key', credentialRevision: '1', knowledgeBaseIds: [], enabled: true }],
    bindings: [{ id: 'tools-binding', version: 'draft', connectionId: 'tools', connectionVersion: 'draft', companyIds: [company],
      subjectIds: [native.id], enabled: true, kind: 'tool', capabilityId: 'mcp.tools', tools: [{ name: 'lookup_asset', inputSchema: schema, readOnly: true }] }] })
  const assignmentId = (await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1', [native.id])).rows[0].runtime_assignment_id
  const claims = { sub: native.id, companyId: company, computerId: null, assignmentId }
  const dispatcher = new McpToolDispatcher((actor, db) => management.resolver(actor, db), async () => {
    if (!await isRuntimeAgentAuthorized(claims)) throw new Error('stale runtime identity')
  })
  assert.equal((await dispatcher.list({ companyId: company, subjectId: native.id })).tools[0].name, 'lookup_asset')
  revoke = true
  await assert.rejects(dispatcher.call({ companyId: company, subjectId: native.id }, 'lookup_asset', { asset: 'fixture' }))
  assert.equal(toolCalls, 0)
  assert.equal(await isRuntimeAgentAuthorized(claims), false)
  assert.deepEqual((await pool.query('SELECT execution_kind,execution_enabled,engine,computer_id FROM participants WHERE id=$1', [native.id])).rows[0], before)
})
