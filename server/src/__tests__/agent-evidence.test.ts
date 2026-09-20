import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceEvidence, presentAnswer, requireAnswer, verifyRouteAEvidence } from '../integrations/agent-evidence.js'

const answer = '第 39 条。<kb doc="https://evil.invalid/伪标题" chunk_id="chunk" kb_id="kb"/>'
const invocation = { id:'invocation', remote_ids:{sessionId:'session',assistantMessageId:'assistant'},result:{answer} }
const source = {knowledge_id:'doc',knowledge_base_id:'kb',chunk_id:'chunk',knowledge_title:'真实来源 · 第 39 条',content:'第 39 条：保留记录。'}
const message = {id:'assistant',session_id:'session',role:'assistant',is_completed:true,agent_id:'agent',content:answer,
  agent_steps:[{iteration:1,tool_calls:[{id:'search',name:'knowledge_search',result:{success:true,data:{results:[source]}}}]}]}
const policy = {remoteAgentId:'agent',knowledgeBaseIds:['kb'],allowedKnowledgeIds:['doc']}

test('only the owned complete assistant contributes same-turn sources; full text is exact', () => {
  const evidence = sourceEvidence({success:true,data:[message]},invocation,policy)
  verifyRouteAEvidence({...invocation,status:'completed'},evidence)
  const shown = presentAnswer(answer,evidence)
  assert.equal(shown.body,'第 39 条。[1]')
  assert.equal(shown.citationStatus,'verified')
  assert.equal(shown.citations[0].title,source.knowledge_title)
  assert.equal(shown.citations[0].content,source.content)
  for (const changed of [{id:'other'},{session_id:'other'},{agent_id:'other'},{role:'user'},{is_completed:false},{content:answer+' '}]) {
    assert.throws(()=>sourceEvidence({success:true,data:[{...message,...changed}]},invocation,policy))
  }
  assert.throws(()=>requireAnswer({status:'completed',result:{answer:' \n'}}),/complete_answer/)
})

test('failed search, unauthorized KB/doc/tool and forged/malformed citations cannot become trusted sources', () => {
  const evidence = sourceEvidence({success:true,data:[message]},invocation,policy)
  for (const forged of ['<kb doc="fake" chunk_id="wrong" kb_id="kb"/>','<kb doc="fake" chunk_id="chunk" kb_id="other"/>','<kb onclick="evil()" chunk_id="chunk" kb_id="kb"/>','<kb doc="fake" chunk_id="chunk" kb_id="kb">']) {
    const shown = presentAnswer(forged,evidence)
    assert.equal(shown.citationStatus,'unverified')
    assert.deepEqual(shown.citations,[])
    assert.equal(shown.body,'[未验证引用]')
  }
  assert.throws(()=>sourceEvidence({success:true,data:[message]},invocation,{...policy,knowledgeBaseIds:['other']}),/allowlist/)
  assert.throws(()=>sourceEvidence({success:true,data:[message]},invocation,{...policy,allowedKnowledgeIds:['other']}),/allowlist/)
  const failed = {...message,agent_steps:[{tool_calls:[{name:'knowledge_search',result:{success:false}}]}]}
  assert.equal(presentAnswer(answer,sourceEvidence({success:true,data:[failed]},invocation,policy)).citationStatus,'unverified')
  const unauthorized = {...message,agent_steps:[{tool_calls:[{name:'web_fetch',result:{success:true}}]}]}
  assert.throws(()=>sourceEvidence({success:true,data:[unauthorized]},invocation,policy),/unapproved_tool/)
})

test('display transformation preserves complete long prose, marks resources, and never adopts model titles', () => {
  const prose = '完整长文'.repeat(10000)
  const shown = presentAnswer(prose+' '+answer+' ![figure](resource://secret/image.png)',sourceEvidence({success:true,data:[message]},invocation,policy))
  assert.ok(shown.body.startsWith(prose))
  assert.ok(shown.body.includes('图片资源未接入'))
  assert.equal(shown.body.includes('resource://'),false)
  assert.equal(shown.citations.some(c=>c.title.includes('evil.invalid')),false)
})
