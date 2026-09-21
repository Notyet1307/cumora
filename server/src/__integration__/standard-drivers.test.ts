import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import express from 'express'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createReferenceReportAgent } from '../../../examples/reference-report-agent/index.js'
import { createAgentRecord } from '../agents/create.js'
import { configureExternalExecution, resolveExecution } from '../agents/execution.js'
import { signAgentToken } from '../agents/runtime/jwt.js'
import { runtimeRouter } from '../agents/runtime/server.js'
import { pool } from '../db/pool.js'
import { a2aCardSha256 } from '../integrations/a2a-agent.js'
import { BindingResolver, type BindingConfig } from '../integrations/bindings.js'
import { ArtifactService } from '../integrations/artifacts.js'
import { McpToolDispatcher, installMcpTools } from '../integrations/mcp-tools.js'
import { MemberAgent, installMemberAgent } from '../integrations/member-agent.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const companyId = 'c-standard-test', userId = 'u-standard-test'
const secret = 'standard-fixture-token-only'
const inputSchema = { type: 'object', properties: { assetId: { type: 'string', enum: ['asset-1'] } }, required: ['assetId'], additionalProperties: false }
let api: Server, origin: string, member: MemberAgent, reporterId: string, reporterToken: string
let config: BindingConfig
const remotes: Server[] = []
let modelCalls: string[] = [], toolCalls = 0
let beforeList: (() => Promise<void>) | undefined
let loseToolResponse = false, toolError = false

async function listen(app: express.Express) {
  const server = createServer(app).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, base: `http://127.0.0.1:${address.port}` }
}
before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(userId)
  app.use('/runtime', runtimeRouter)
  const listening = await listen(app)
  api = listening.server; origin = listening.base
})
beforeEach(async () => {
  await resetAllTables()
  modelCalls = []; toolCalls = 0; beforeList = undefined; loseToolResponse = false; toolError = false
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Standards fixture','standards-fixture',$2)", [companyId, userId])
  await seedUserMembership(userId, companyId)
  reporterId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10, name: 'Standards native', systemPrompt: 'Synthetic only' })).id
  const row = (await pool.query('SELECT computer_id,runtime_assignment_id FROM participants WHERE id=$1', [reporterId])).rows[0]
  reporterToken = signAgentToken({ agentId: reporterId, companyId, computerId: row.computer_id, assignmentId: row.runtime_assignment_id })
  config = { schemaVersion: 1, connections: [], bindings: [] }
  member = new MemberAgent(pool)
  installMemberAgent(member)
})
afterEach(async () => {
  installMcpTools(undefined)
  await member.stop()
  for (const server of remotes.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
after(async () => { await teardownAll(api) })
async function post(path: string, body: unknown) {
  const response = await fetch(origin + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-company-id': companyId }, body: JSON.stringify(body) })
  return { status: response.status, value: await response.json() as { id: string } }
}
async function native(argv: string[]) {
  const response = await fetch(origin + '/runtime/cli', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reporterToken}` }, body: JSON.stringify({ argv }) })
  return { status: response.status, value: await response.json() as import('../agents/cli-result.js').CliResult }
}
async function command(argv: string[]) {
  try {
    const result = await promisify(execFile)('sh', [fileURLToPath(new URL('../../docker/agent-computer-cumora.sh', import.meta.url)), ...argv],
      { env: { PATH: process.env.PATH, CUMORA_AGENT_RUNTIME_URL: origin + '/runtime', CUMORA_AGENT_RUNTIME_TOKEN: reporterToken, CUMORA_CLI_TIMEOUT: '15' } })
    return { exitCode: 0, text: result.stdout }
  } catch (error) {
    const failed = error as { code: number; stdout: string }
    return { exitCode: failed.code, text: failed.stdout }
  }
}
async function addReference(name: string, dropResponse = false) {
  const agentId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10, name, systemPrompt: 'External only', executionKind: 'external-service' })).id
  const wrapper = express()
  const { server, base } = await listen(wrapper)
  remotes.push(server)
  const reference = createReferenceReportAgent({ baseUrl: base + '/a2a', apiKey: secret, generate: async ({ input }) => {
    modelCalls.push(agentId)
    if (dropResponse) server.closeAllConnections()
    return `# Independent synthetic report\n\n${input}\n\n${'Full evidence retained. '.repeat(300)}\nEND-OF-COMPLETE-REPORT`
  } })
  wrapper.use(reference.app)
  const digest = a2aCardSha256(reference.card)
  config.connections.push({ id: agentId, version: '1', kind: 'agent-service', backend: 'a2a', baseUrl: base + '/a2a', secretRef: 'fixture', credentialRevision: '1', knowledgeBaseIds: [], enabled: true })
  config.bindings.push({ id: agentId, version: '1', connectionId: agentId, connectionVersion: '1', companyIds: [companyId], subjectIds: [agentId], enabled: true,
    kind: 'agent-service', capabilityId: 'a2a.agent', remoteAgentId: reference.card.skills[0].id,
    approval: { authorizationVersion: '1', tenantId: 'synthetic-reference', effectiveConfigDigest: digest, cardSha256: digest, protocolVersion: '0.3.0' } })
  const room = `dm-${agentId}`
  await pool.query('INSERT INTO conversations(id,kind,title,members,company_id) VALUES($1,\'direct\',\'Reference fixture\',$2::jsonb,$3)', [room, JSON.stringify([userId, agentId]), companyId])
  return { agentId, room }
}
async function activate() {
  const bindings = new BindingResolver(config, { fixture: secret })
  for (const binding of config.bindings.filter(b => b.kind === 'agent-service')) {
    const actor = { companyId, subjectId: binding.subjectIds[0] }
    const row = (await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1', [actor.subjectId])).rows[0]
    await configureExternalExecution(actor, { assignmentId: row.runtime_assignment_id, enabled: true }, bindings)
  }
  member = new MemberAgent(pool, bindings); installMemberAgent(member)
  installMcpTools(new McpToolDispatcher(bindings, async actor => {
    if ((await resolveExecution(actor)).kind !== 'native') throw new Error('native_required')
  }))
}
async function addMcp() {
  const app = express()
  app.use(express.json())
  app.all('/mcp', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}`) { res.sendStatus(401); return }
    if (req.method !== 'POST') { res.sendStatus(405); return }
    const server = new McpServer({ name: 'read-only-synthetic-assets', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await beforeList?.()
      return { tools: [{ name: 'lookup_asset', inputSchema, annotations: { readOnlyHint: true } }, { name: 'unapproved_write', inputSchema: { type: 'object' } }] }
    })
    server.setRequestHandler(CallToolRequestSchema, async request => {
      toolCalls++
      assert.equal(request.params.name, 'lookup_asset')
      assert.deepEqual(request.params.arguments, { assetId: 'asset-1' })
      if (loseToolResponse) { req.socket.destroy(); return { content: [] } }
      return { isError: toolError, content: [{ type: 'text', text: 'Asset 1: synthetic read-only inventory; not production evidence.' }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
  const { server, base } = await listen(app)
  remotes.push(server)
  config.connections.push({ id: 'assets', version: '1', kind: 'tool', backend: 'mcp', baseUrl: base + '/mcp', secretRef: 'fixture', credentialRevision: '1', knowledgeBaseIds: [], enabled: true })
  config.bindings.push({ id: 'asset-reader', version: '1', connectionId: 'assets', connectionVersion: '1', companyIds: [companyId], subjectIds: [reporterId], enabled: true,
    kind: 'tool', capabilityId: 'mcp.tools', tools: [{ name: 'lookup_asset', inputSchema, readOnly: true }] })
}

test('two independent A2A instances use only config and retain full E3-compatible provenance', async () => {
  const first = await addReference('Reference one'), second = await addReference('Reference two')
  await activate()
  for (const target of [first, second]) {
    const sent = await post(`/conversations/${target.room}/messages`, { body: 'SYNTHETIC QUESTION: preserve the complete report.', clientId: randomUUID() })
    assert.equal(sent.status, 202)
    await member.drain()
    const delivery = (await pool.query('SELECT * FROM external_message_deliveries WHERE source_message_id=$1', [sent.value.id])).rows[0]
    assert.equal(delivery.status, 'completed')
    const invocation = (await pool.query('SELECT * FROM external_invocations WHERE id=$1', [delivery.invocation_id])).rows[0]
    assert.equal(invocation.result.answer.endsWith('END-OF-COMPLETE-REPORT'), true)
    assert.ok(invocation.remote_ids.contextId && invocation.remote_ids.taskId)
    assert.equal(invocation.remote_ids.sessionId, undefined)
    assert.deepEqual(invocation.result.validation.evidence.sources, [])
    const artifact = await new ArtifactService(pool).capture({ companyId, subjectId: userId }, { deliveryId: delivery.id, title: 'Independent fixed report' })
    const snapshot = await new ArtifactService(pool).readVersion({ companyId, subjectId: userId }, artifact.id, 1)
    assert.equal(snapshot.body, invocation.result.answer)
    assert.deepEqual(snapshot.citations, [])
    await member.drain()
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE external_delivery_id=$1', [delivery.id])).rows[0].n, 1)
    const followup = await post(`/conversations/${target.room}/messages`, { body: 'SYNTHETIC FOLLOWUP' })
    await member.drain()
    const next = (await pool.query('SELECT i.remote_ids FROM external_invocations i JOIN external_message_deliveries d ON d.invocation_id=i.id WHERE d.source_message_id=$1', [followup.value.id])).rows[0]
    assert.equal(next.remote_ids.contextId, invocation.remote_ids.contextId)
    await pool.query(`UPDATE external_invocations SET remote_ids=jsonb_set(remote_ids,'{contextId}','"unrelated-context"') WHERE id=$1`, [invocation.id])
    await assert.rejects(new ArtifactService(pool).capture({ companyId, subjectId: userId }, { deliveryId: delivery.id, title: 'Mismatched receipt' }), /artifact_source_mismatch/)
  }
  assert.deepEqual(modelCalls, [first.agentId, first.agentId, second.agentId, second.agentId])
})

test('A2A accepted execution with a lost response remains unknown and blocks later dispatch', async () => {
  const target = await addReference('Ambiguous reference', true)
  await activate()
  const sent = await post(`/conversations/${target.room}/messages`, { body: 'SYNTHETIC AMBIGUOUS REQUEST' })
  await member.drain()
  const first = (await pool.query('SELECT status FROM external_message_deliveries WHERE source_message_id=$1', [sent.value.id])).rows[0]
  assert.equal(first.status, 'blocked_unknown')
  await post(`/conversations/${target.room}/messages`, { body: 'DO NOT DISPATCH WHILE UNKNOWN' })
  await member.drain()
  assert.deepEqual(modelCalls, [target.agentId])
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE author_id=$1', [target.agentId])).rows[0].n, 0)
})

test('native runtime CLI exposes only approved MCP tools and never retries ambiguous calls', async () => {
  await addMcp(); await activate()
  const listed = await native(['tools', 'list'])
  assert.equal(listed.value.ok, true, listed.value.text)
  const listing = JSON.parse(listed.value.text)
  assert.deepEqual(listing.tools.map((tool: { name: string }) => tool.name), ['lookup_asset'])
  const denied = await native(['tools', 'call', 'unapproved_write', '{}'])
  assert.equal(denied.value.ok, false)
  assert.equal(toolCalls, 0)
  const malformed = await native(['tools', 'call', 'lookup_asset', '{"assetId":"asset-1","extra":true}'])
  assert.equal(malformed.value.ok, false)
  assert.equal(toolCalls, 0)
  const allowed = await command(['tools', 'call', 'lookup_asset', '{"assetId":"asset-1"}'])
  assert.equal(allowed.exitCode, 0, allowed.text)
  assert.match(allowed.text, /synthetic read-only inventory/)
  assert.equal(toolCalls, 1)
  toolError = true
  const failed = await command(['tools', 'call', 'lookup_asset', '{"assetId":"asset-1"}'])
  assert.equal(failed.exitCode, 1)
  assert.equal(JSON.parse(failed.text).status, 'failed')
  toolError = false
  loseToolResponse = true
  const unknown = await command(['tools', 'call', 'lookup_asset', '{"assetId":"asset-1"}'])
  assert.equal(unknown.exitCode, 1)
  assert.match(unknown.text, /outcome=unknown/)
  assert.equal(toolCalls, 3)
})

test('assignment revocation between MCP discovery and invocation fences the original JWT', async () => {
  await addMcp(); await activate()
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const observed = new Promise<void>(resolve => { entered = resolve })
  beforeList = async () => { entered(); await blocked }
  const pending = native(['tools', 'call', 'lookup_asset', '{"assetId":"asset-1"}'])
  try {
    await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(new Error('discovery not reached')), 5000).unref())])
    await pool.query('UPDATE participants SET runtime_assignment_id=gen_random_uuid() WHERE id=$1', [reporterId])
  } finally { release() }
  assert.equal((await pending).value.ok, false)
  assert.equal(toolCalls, 0)
  assert.equal((await native(['tools', 'list'])).status, 403)
})
