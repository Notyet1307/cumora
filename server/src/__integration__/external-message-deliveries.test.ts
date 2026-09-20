import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { createAgentRecord } from '../agents/create.js'
import { configureExternalExecution } from '../agents/execution.js'
import { BindingResolver } from '../integrations/bindings.js'
import { MemberAgent, installMemberAgent } from '../integrations/member-agent.js'
import { InvocationStore } from '../integrations/invocations.js'
import { bindingSnapshot } from '../integrations/agent-execution.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'
import { ExternalAgentFixture, FIXTURE_ANSWER } from './external-agent-fixture.js'

const companyId = 'c-external-delivery-test'
const userId = 'u-external-delivery-test'
const room = 'dm-external-test'
const group = 'group-external-test'
let memberId: string
let fixture: ExternalAgentFixture
let service: MemberAgent
let bindings: BindingResolver
let server: Server
let origin: string
const headers = { 'content-type': 'application/json', 'x-company-id': companyId }

before(async () => {
  await ensureSchemaOnce()
  server = createServer(await buildApiTestApp(userId)).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_server_missing')
  origin = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await resetAllTables()
  fixture = new ExternalAgentFixture()
  await fixture.start()
  await pool.query("INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'External test','external-test',$2)", [companyId,userId])
  await seedUserMembership(userId, companyId)
  memberId = (await createAgentRecord({ companyId, tier: 'pro', maxActiveAgents: 10, name: 'Synthetic external', systemPrompt: 'External only', executionKind: 'external-service' })).id
  bindings = new BindingResolver(fixture.config(companyId,memberId), { 'fixture-chat': 'fixture-chat-only' })
  const assignment = (await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1 AND company_id=$2',[memberId,companyId])).rows[0].runtime_assignment_id
  await configureExternalExecution({ companyId,subjectId: memberId }, { assignmentId: assignment, enabled: true }, bindings)
  for (const [id, kind] of [[room,'direct'],[group,'group']]) await pool.query('INSERT INTO conversations(id,kind,title,members,company_id) VALUES($1,$2,$1,$3::jsonb,$4)', [id,kind,JSON.stringify([userId,memberId]),companyId])
  service = new MemberAgent(pool, bindings)
  installMemberAgent(service)
})
afterEach(async () => { await service.stop(); await fixture.close() })
after(async () => { await teardownAll(server) })

async function post(body: string, conversationId = room, extra: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/api/conversations/${conversationId}/messages`, { method:'POST',headers,body:JSON.stringify({body,...extra}) })
  return { status:response.status, value: await response.json() as {id:string; sequence:number} }
}
async function delivery(sourceId: string) {
  return (await pool.query('SELECT * FROM external_message_deliveries WHERE source_message_id=$1',[sourceId])).rows[0]
}
const submits = () => fixture.requests.filter(r => r.path.includes('/agent-chat/'))

async function failPublications() {
  await pool.query(`CREATE FUNCTION ea202_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.external_delivery_id IS NOT NULL THEN RAISE EXCEPTION 'injected publication failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER ea202_fail_publish BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION ea202_fail_publish()`)
}
async function restorePublications() {
  await pool.query('DROP TRIGGER IF EXISTS ea202_fail_publish ON messages; DROP FUNCTION IF EXISTS ea202_fail_publish()')
}

test('human DM/exact mentions admit atomically; duplicate HTTP never adds a delivery or submission', async () => {
  const [first,retry] = await Promise.all([post('synthetic',room,{clientId:'same'}),post('synthetic',room,{clientId:'same'})])
  assert.equal(first.status,202); assert.equal(first.value.id,retry.value.id)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_message_deliveries')).rows[0].n,1)
  for (const text of ['@all generic', 'no mention', `@${memberId}-suffix wrong`]) {
    const ignored = await post(text,group)
    assert.equal(await delivery(ignored.value.id),undefined)
  }
  const mention = await post(`@${memberId} specific`,group,{bindingId:'attacker',knowledge_base_ids:['other'],url:'http://untrusted.invalid'})
  assert.equal((await delivery(mention.value.id)).status,'queued')
  await service.drain(); await service.drain()
  assert.equal(submits().length,2)
  assert.deepEqual(submits()[0].body.knowledge_base_ids,['kb-test'])
  assert.equal(submits()[0].body.query,'synthetic')
  await new MemberAgent(pool,bindings).drain()
  await post('changed retry ignored',room,{clientId:'same'})
  assert.equal(submits().length,2)
  const final = await delivery(first.value.id)
  assert.equal(final.status,'completed')
  const published = (await pool.query('SELECT * FROM messages WHERE id=$1',[final.final_message_id])).rows[0]
  assert.equal(published.author_id,memberId); assert.equal(published.conversation_id,room); assert.equal(published.quoted_message_id,first.value.id)
  assert.equal(published.body,FIXTURE_ANSWER.replace(/<kb[^>]+\/>/,'[1]'))
  assert.equal(published.external_result.citations[0].title,'合成审查规范 · 第 39 条')
  const history = await fetch(`${origin}/api/conversations/${room}/messages`,{headers}).then(r=>r.json()) as Array<{id:string; externalDeliveries:Array<{status:string}>}>
  assert.equal(history.find(m=>m.id===first.value.id)!.externalDeliveries[0].status,'completed')
})

test('delivery write faults roll back source, counter and outbox together', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM realtime_outbox')).rows[0].n
  await pool.query(`CREATE FUNCTION ea202_fail_admit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected admission failure'; END $$;
    CREATE TRIGGER ea202_fail_admit BEFORE INSERT ON external_message_deliveries FOR EACH ROW EXECUTE FUNCTION ea202_fail_admit()`)
  try { assert.equal((await post('rollback')).status,500) }
  finally { await pool.query('DROP TRIGGER ea202_fail_admit ON external_message_deliveries; DROP FUNCTION ea202_fail_admit()') }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1',[room])).rows[0].n,0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_counters WHERE conversation_id=$1',[room])).rows[0].n,0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM realtime_outbox')).rows[0].n,before)
  assert.equal(submits().length,0)
})

test('input boundaries are explicit, no truncation; pure attachments never leave and actor kind is authoritative', async () => {
  assert.equal((await post('')).status,400)
  const limit = await post('a'.repeat(8000))
  const tooLong = await post('a'.repeat(8001))
  assert.equal((await delivery(tooLong.value.id)).reason,'input_too_long')
  const attachment = {url:'/uploads/attachments/fixture.png',name:'fixture.png',key:'attachments/fixture.png',kind:'img'}
  const only = await post('',room,{attachment})
  assert.equal(only.status,202)
  assert.equal((await delivery(only.value.id)).reason,'text_required')
  await service.drain()
  assert.equal(submits()[0].body.query,'a'.repeat(8000))
  assert.equal((await delivery(limit.value.id)).status,'completed')
  await pool.query("UPDATE participants SET kind='agent' WHERE company_id=$1 AND id=$2",[companyId,userId])
  const agent = await post('agent cannot cause external call')
  assert.equal(await delivery(agent.value.id),undefined)
  await pool.query('DELETE FROM conversation_members WHERE company_id=$1 AND conversation_id=$2 AND participant_id=$3',[companyId,room,userId])
  assert.equal((await post('denied')).status,403)
})

test('two workers serialize a member across rooms and persist history before next POST', async () => {
  fixture.hold = true
  const first = await post('first')
  const second = await post(`@${memberId} second`,group)
  const submitted = once(fixture.server,'submitted')
  const running = service.drain()
  await submitted
  await new MemberAgent(pool,bindings).drain()
  assert.equal(submits().length,1)
  assert.equal((await delivery(second.value.id)).invocation_id,null)
  fixture.resume(); await running
  await service.drain()
  assert.equal(submits().length,2)
  const order = fixture.requests.map(r=>r.path)
  assert.ok(order.indexOf('/api/v1/messages/session-1/load?limit=2') < order.indexOf('/api/v1/agent-chat/session-2'))
  assert.notEqual((await pool.query('SELECT session_scope FROM external_invocations WHERE source_id=$1',[first.value.id])).rows[0].session_scope,
    (await pool.query('SELECT session_scope FROM external_invocations WHERE source_id=$1',[second.value.id])).rows[0].session_scope)
})

test('unknown survives restart, blocks later room/source and forbids re-enable', async () => {
  fixture.mode = 'unknown'
  const first = await post('uncertain')
  await service.drain()
  assert.equal((await delivery(first.value.id)).status,'blocked_unknown')
  const waiting = await post(`@${memberId} later`,group)
  await new MemberAgent(pool,bindings).drain()
  assert.equal(submits().length,1)
  assert.equal((await delivery(waiting.value.id)).status,'blocked_unknown')
  assert.equal(fixture.requests.some(r=>/stop|continue-stream/.test(r.path)),false)
  const assignment = (await pool.query('SELECT runtime_assignment_id FROM participants WHERE id=$1',[memberId])).rows[0].runtime_assignment_id
  const disabled = await configureExternalExecution({companyId,subjectId:memberId},{assignmentId:assignment,enabled:false},bindings)
  await assert.rejects(configureExternalExecution({companyId,subjectId:memberId},{assignmentId:disabled,enabled:true},bindings),/pending/)
})

test('expired dispatch lease becomes unknown without a remote retry', async () => {
  const source = await post('crashed after claim')
  const d = await delivery(source.value.id)
  const store = new InvocationStore(pool)
  const actor = {companyId,subjectId:memberId}
  const selected = bindings.resolve(actor,'weknora.agent','agent-service')
  assert.ok(selected.ok)
  const invocation = await store.accept(actor,{sourceKind:'chat-message',sourceId:source.value.id,query:'crashed after claim',
    conversationScope:JSON.stringify([room,d.context_id,d.assignment_id]),snapshot:bindingSnapshot(selected.binding)})
  await store.claim(actor,invocation.id)
  await pool.query("UPDATE external_invocations SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[invocation.id])
  await pool.query("UPDATE external_message_deliveries SET invocation_id=$2,status='running' WHERE id=$1",[d.id,invocation.id])
  await new MemberAgent(pool,bindings).drain()
  assert.equal((await delivery(source.value.id)).status,'blocked_unknown')
  assert.equal(submits().length,0)
})

test('normalized leave/rejoin and legacy projection writes rotate context and never reuse previous Session', async () => {
  await post('before membership'); await service.drain()
  const stale = await post('accepted before change')
  const old = (await delivery(stale.value.id)).context_id
  await pool.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND participant_id=$2',[room,memberId])
  await pool.query('INSERT INTO conversation_members(conversation_id,company_id,participant_id,ordinal) VALUES($1,$2,$3,1)',[room,companyId,memberId])
  await service.drain()
  assert.equal((await delivery(stale.value.id)).status,'withheld')
  assert.notEqual((await pool.query('SELECT external_context_id FROM conversations WHERE id=$1',[room])).rows[0].external_context_id,old)
  await post('after rejoin'); await service.drain()
  assert.equal(fixture.requests.filter(r=>r.path==='/api/v1/sessions').length,2)
  const projected = await post('before projection change')
  await pool.query('UPDATE conversations SET members=$2::jsonb WHERE id=$1',[room,JSON.stringify([userId])])
  await pool.query('UPDATE conversations SET members=$2::jsonb WHERE id=$1',[room,JSON.stringify([userId,memberId])])
  await service.drain()
  assert.equal((await delivery(projected.value.id)).status,'withheld')
})

test('publication failure retries only the transaction, with one final reply and one message outbox event', async () => {
  const source = await post('publication retry')
  await failPublications()
  try { await assert.rejects(service.drain(),/injected publication failure/) } finally { await restorePublications() }
  assert.equal(submits().length,1)
  await Promise.all([service.publishExternalResult((await delivery(source.value.id)).id),new MemberAgent(pool,bindings).drain()])
  assert.equal(submits().length,1)
  const d = await delivery(source.value.id)
  assert.equal(d.status,'completed')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE external_delivery_id=$1',[d.id])).rows[0].n,1)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM realtime_outbox WHERE payload->'message'->>'id'=$1",[d.final_message_id])).rows[0].n,1)
})

for (const mutation of ['edit','delete','revoke','disable','expire'] as const) test(`completed result is withheld after ${mutation}, never retried remotely`, async () => {
  const source = await post(`withhold ${mutation}`)
  await failPublications()
  try { await assert.rejects(service.drain()) } finally { await restorePublications() }
  const d = await delivery(source.value.id)
  if (mutation === 'edit') await pool.query("UPDATE messages SET body='changed' WHERE id=$1",[source.value.id])
  if (mutation === 'delete') await pool.query('DELETE FROM messages WHERE id=$1',[source.value.id])
  if (mutation === 'revoke') await pool.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND participant_id=$2',[room,userId])
  if (mutation === 'disable') await pool.query('UPDATE participants SET execution_enabled=false WHERE id=$1',[memberId])
  if (mutation === 'expire') await pool.query("UPDATE external_invocations SET content_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[d.invocation_id])
  await new MemberAgent(pool,bindings).drain()
  assert.equal((await delivery(source.value.id)).status,'withheld')
  assert.equal((await delivery(source.value.id)).final_message_id,null)
  assert.equal(submits().length,1)
})

test('empty/mismatched answers and out-of-scope sources produce only safe failure messages', async () => {
  for (const mode of ['empty','mismatch','wrong-source'] as const) {
    fixture.answer = mode === 'empty' ? '' : FIXTURE_ANSWER
    fixture.mode = mode === 'empty' ? 'complete' : mode
    const source = await post(mode)
    await service.drain()
    const d = await delivery(source.value.id)
    assert.equal(d.status,'failed')
    const message = (await pool.query('SELECT body FROM messages WHERE id=$1',[d.final_message_id])).rows[0]
    assert.equal(message.body.includes('本地协议 fixture'),false)
    assert.ok(message.body.includes(d.invocation_id))
  }
  assert.equal(submits().length,3)
})

test('detail checks current ACL, expires without re-execution; published chat retains its complete body', async () => {
  const source = await post('detail')
  await service.drain()
  const d = await delivery(source.value.id)
  const detailUrl = `${origin}/api/external-deliveries/${d.id}`
  const detail = await fetch(detailUrl,{headers}).then(r=>r.json()) as {answer:string}
  assert.equal(detail.answer,FIXTURE_ANSWER)
  await pool.query("UPDATE external_message_deliveries SET content_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[d.id])
  assert.equal((await fetch(detailUrl,{headers}).then(r=>r.json()) as {status:string}).status,'expired')
  await pool.query('DELETE FROM conversation_members WHERE conversation_id=$1 AND participant_id=$2',[room,userId])
  assert.equal((await fetch(detailUrl,{headers})).status,404)
  assert.equal((await pool.query('SELECT body FROM messages WHERE id=$1',[d.final_message_id])).rows[0].body,FIXTURE_ANSWER.replace(/<kb[^>]+\/>/,'[1]'))
  assert.equal(submits().length,1)
})

test('claim rollback is retryable but lost remote IDs are unknown and never resubmitted', async () => {
  const source = await post('claim fault')
  await pool.query(`CREATE FUNCTION ea202_fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='dispatching' THEN RAISE EXCEPTION 'claim failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER ea202_fail_claim BEFORE UPDATE ON external_invocations FOR EACH ROW EXECUTE FUNCTION ea202_fail_claim()`)
  try { await assert.rejects(service.drain(),/claim failed/) }
  finally { await pool.query('DROP TRIGGER ea202_fail_claim ON external_invocations; DROP FUNCTION ea202_fail_claim()') }
  assert.equal(submits().length,0)
  assert.equal((await delivery(source.value.id)).status,'queued')
  await pool.query(`CREATE FUNCTION ea202_fail_ids() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.remote_ids->>'assistantMessageId' IS NOT NULL THEN RAISE EXCEPTION 'IDs failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER ea202_fail_ids BEFORE UPDATE ON external_invocations FOR EACH ROW EXECUTE FUNCTION ea202_fail_ids()`)
  try { await service.drain() }
  finally { await pool.query('DROP TRIGGER ea202_fail_ids ON external_invocations; DROP FUNCTION ea202_fail_ids()') }
  assert.equal((await delivery(source.value.id)).status,'blocked_unknown')
  await new MemberAgent(pool,bindings).drain()
  assert.equal(submits().length,1)
})

test('disable commits during the network wait and fences history and publication', async () => {
  fixture.hold=true
  const source=await post('disable in flight')
  const submitted=once(fixture.server,'submitted')
  const running=service.drain()
  await submitted
  const assignment=(await delivery(source.value.id)).assignment_id
  await configureExternalExecution({companyId,subjectId:memberId},{assignmentId:assignment,enabled:false},bindings)
  fixture.resume()
  await running
  assert.equal((await delivery(source.value.id)).status,'withheld')
  assert.equal(fixture.requests.some(r=>r.path.includes('/messages/')),false)
  assert.equal(submits().length,1)
})

test('expired Session mappings rotate without losing source tombstones', async () => {
  const first=await post('old session')
  await service.drain()
  await pool.query("UPDATE external_sessions SET content_expires_at=NOW()-INTERVAL '1 second'")
  const second=await post('new session')
  await service.drain()
  assert.equal(fixture.requests.filter(r=>r.path==='/api/v1/sessions').length,2)
  assert.notEqual((await delivery(first.value.id)).invocation_id,(await delivery(second.value.id)).invocation_id)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM external_invocations')).rows[0].n,2)
})

test('complete stream retains member exclusion until owned history is verified', async () => {
  await post('first history')
  await post('second history')
  fixture.pauseAt = 'history'
  const reached = once(fixture.server, 'history-requested', {signal: AbortSignal.timeout(5000)})
  const running = service.drain()
  try {
    await reached
    await new MemberAgent(pool, bindings).drain()
    assert.equal(submits().length, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE external_delivery_id IS NOT NULL')).rows[0].n, 0)
  } finally { fixture.resume(); await running }
  await new MemberAgent(pool, bindings).drain()
  assert.equal(submits().length, 2)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM external_message_deliveries WHERE status='completed'")).rows[0].n, 2)
})

test('disable between Session creation and chat prevents the subsequent agent POST', async () => {
  const source = await post('disable before POST')
  fixture.pauseAt = 'session'
  const reached = once(fixture.server, 'session-requested', {signal: AbortSignal.timeout(5000)})
  const running = service.drain()
  try {
    await reached
    await configureExternalExecution({companyId,subjectId:memberId},
      {assignmentId:(await delivery(source.value.id)).assignment_id,enabled:false},bindings)
  } finally { fixture.resume(); await running }
  assert.equal(submits().length, 0)
  assert.equal((await delivery(source.value.id)).final_message_id, null)
  await new MemberAgent(pool, bindings).drain()
  assert.equal(fixture.requests.length, 1)
})
