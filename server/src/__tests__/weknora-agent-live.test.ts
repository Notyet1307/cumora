import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyRouteAEvidence } from '../integrations/agent-evidence.js'

const invocation = {
  id: 'invocation-1', status: 'completed' as const,
  remote_ids: { sessionId: 'session-1', assistantMessageId: 'answer-1' },
  result: { answer: '事实依据。<kb doc="standard.pdf" chunk_id="chunk-1" kb_id="kb-1" />', references: [] },
}
const evidence = {
  invocationId: 'invocation-1', sessionId: 'session-1', assistantMessageId: 'answer-1', remoteAnswerMatches: true,
  sources: [{ chunk_id: 'chunk-1', knowledge_base_id: 'kb-1', knowledge_id: 'document-1' }],
}

test('route A accepts body citations without structured references only with same-turn evidence', () => {
  verifyRouteAEvidence(invocation, evidence)
  assert.throws(() => verifyRouteAEvidence(invocation, { ...evidence, sources: [] }), /successful_sources_required/)
  assert.throws(() => verifyRouteAEvidence(invocation, { ...evidence, sessionId: 'previous-session' }), /source_message_mismatch/)
  assert.throws(() => verifyRouteAEvidence(invocation, { ...evidence, remoteAnswerMatches: false }), /source_message_mismatch/)
})

test('a real-looking citation cannot substitute a different chunk or knowledge base', () => {
  for (const answer of [
    invocation.result.answer.replace('chunk-1', 'uncited-chunk'),
    invocation.result.answer.replace('kb-1', 'other-kb'),
  ]) {
    assert.throws(() => verifyRouteAEvidence({ ...invocation, result: { ...invocation.result, answer } }, evidence), /citation_not_in_this_turn/)
  }
})

test('upstream completion alone never accepts empty or uncited prose', () => {
  assert.throws(() => verifyRouteAEvidence({ ...invocation, result: { answer: '' } }, evidence), /complete_answer_required/)
  assert.throws(() => verifyRouteAEvidence({ ...invocation, result: { answer: '正确但没有引用的答案' } }, evidence), /route_a_body_citations_required/)
})

test('unparsed attribute residue cannot turn a malformed citation into verified evidence', () => {
  const answer = invocation.result.answer.replace('<kb ', '<kb forged=x ')
  assert.throws(() => verifyRouteAEvidence({ ...invocation, result: { answer } }, evidence), /invalid_body_citation/)
})
