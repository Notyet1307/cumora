import type { Invocation } from './invocations.js'

type JsonObject = Record<string, unknown>
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}
function object(value: unknown): JsonObject {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_object')
  return value as JsonObject
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

export function requireAnswer(invocation: Pick<Invocation, 'status' | 'result'>): void {
  requireValue(invocation.status === 'completed' && typeof invocation.result?.answer === 'string'
    && invocation.result.answer.trim().length > 0, 'complete_answer_required')
}

export function verifyRouteAEvidence(invocation: Pick<Invocation, 'id' | 'status' | 'result' | 'remote_ids'>, value: unknown): void {
  requireAnswer(invocation)
  const evidence = object(value)
  requireValue(evidence.invocationId === invocation.id && evidence.sessionId === invocation.remote_ids?.sessionId
    && evidence.assistantMessageId === invocation.remote_ids?.assistantMessageId && evidence.remoteAnswerMatches === true,
  'source_message_mismatch')
  requireValue(Array.isArray(evidence.sources) && evidence.sources.length > 0, 'successful_sources_required')
  const sources = evidence.sources.map(object)
  const citations = [...String(invocation.result!.answer).matchAll(/<kb\b([^<>]*)\/>/g)]
  requireValue(citations.length > 0, 'route_a_body_citations_required')
  requireValue([...String(invocation.result!.answer).matchAll(/<kb\b/g)].length === citations.length, 'invalid_body_citation')
  for (const citation of citations) {
    const attrs = citationAttributes(citation[1])
    requireValue(attrs, 'invalid_body_citation')
    requireValue(sources.some(source => source.chunk_id === attrs.chunk_id && source.knowledge_base_id === attrs.kb_id), 'citation_not_in_this_turn')
  }
}

function citationAttributes(raw: string): Record<string, string> | null {
  if (!/^(?:\s+(?:doc|chunk_id|kb_id)="[^"]*")+\s*$/.test(raw)) return null
  const pairs = [...raw.matchAll(/([a-z_]+)="([^"]*)"/g)].map(match => [match[1], match[2]])
  const attrs = Object.fromEntries(pairs)
  return Object.keys(attrs).length === pairs.length && attrs.doc && identifier(attrs.chunk_id) && identifier(attrs.kb_id) ? attrs : null
}

export function sourceEvidence(response: JsonObject, invocation: Pick<Invocation, 'id' | 'remote_ids' | 'result'>,
  policy: { remoteAgentId: string; knowledgeBaseIds: readonly string[]; allowedKnowledgeIds?: readonly string[]; allowedTools?: readonly string[] }): JsonObject {
  requireValue(response.success === true && Array.isArray(response.data) && response.data.length <= 2, 'invalid_message_envelope')
  const selected = response.data.map(object).filter(message => message.id === invocation.remote_ids?.assistantMessageId)
  requireValue(selected.length === 1, 'assistant_message_not_loaded')
  const message = selected[0]
  requireValue(message.session_id === invocation.remote_ids?.sessionId && message.role === 'assistant' && message.is_completed === true
    && message.agent_id === policy.remoteAgentId && Array.isArray(message.agent_steps), 'assistant_message_mismatch')
  requireValue(typeof message.content === 'string' && message.content === invocation.result?.answer, 'upstream_answer_mismatch')
  const sources: JsonObject[] = []
  const calls: JsonObject[] = []
  const sourceFields = ['result_index', 'content', 'knowledge_id', 'knowledge_base_id', 'knowledge_title', 'chunk_id', 'chunk_index', 'faq_id', 'index', 'source_query', 'query_type', 'match_type', 'knowledge_base_type']
  requireValue(message.agent_steps.length <= 100, 'step_limit')
  for (const stepValue of message.agent_steps) {
    const step = object(stepValue)
    const toolCalls = step.tool_calls ?? []
    requireValue(Array.isArray(toolCalls) && toolCalls.length <= 100, 'invalid_tool_calls')
    for (const callValue of toolCalls) {
      const call = object(callValue)
      requireValue(typeof call.name === 'string' && (policy.allowedTools ?? ['knowledge_search']).includes(call.name), 'unapproved_tool_used')
      if (call.name !== 'knowledge_search') continue
      const result = object(call.result)
      calls.push({ iteration: step.iteration, toolCallId: call.id, success: result.success })
      if (result.success !== true) continue
      const data = object(result.data)
      requireValue(Array.isArray(data.results) && data.results.length <= 100, 'invalid_search_results')
      for (const item of data.results) {
        const source = object(item)
        requireValue(identifier(source.knowledge_id) && (!policy.allowedKnowledgeIds || policy.allowedKnowledgeIds.includes(source.knowledge_id))
          && typeof source.knowledge_base_id === 'string' && policy.knowledgeBaseIds.includes(source.knowledge_base_id), 'source_outside_allowlist')
        const picked = Object.fromEntries(sourceFields.filter(field => Object.hasOwn(source, field)).map(field => [field, source[field]]))
        requireValue(Object.values(picked).every(value => typeof value === 'string' || typeof value === 'number'), 'invalid_source_fields')
        sources.push({ iteration: step.iteration, toolCallId: call.id, ...picked })
        requireValue(sources.length <= 100, 'source_limit')
      }
    }
  }
  return { invocationId: invocation.id, sessionId: message.session_id, assistantMessageId: message.id, remoteAnswerMatches: true, calls, sources,
    sourceExtraction: 'agent_steps.tool_calls.result.data.results; no thoughts, raw output, or other messages retained',
    limitation: sources.length ? 'Original document verification remains operator-owned' : 'No successful knowledge_search source rows available' }
}

export interface VerifiedCitation {
  number: number
  knowledgeBaseId: string
  knowledgeId: string
  chunkId: string
  title: string
  content: string
  chunkIndex?: string | number
  level: 'same-turn-search'
}
export interface AnswerPresentation {
  body: string
  citations: VerifiedCitation[]
  citationStatus: 'verified' | 'unverified' | 'none'
}

/** Raw answer stays in Result. Only proven source fields become visible citations. */
export function presentAnswer(answer: string, evidence: JsonObject): AnswerPresentation {
  const sources = Array.isArray(evidence.sources) ? evidence.sources.map(object) : []
  const citations: VerifiedCitation[] = []
  let unverified = false
  const body = answer.replace(/<kb\b[^<>]*\/>|<kb\b[^<>]*>|<kb\b/gi, tag => {
    const raw = /^<kb\b([^<>]*)\/>$/.exec(tag)
    const attrs = raw && citationAttributes(raw[1])
    const source = attrs && sources.find(s => s.chunk_id === attrs.chunk_id && s.knowledge_base_id === attrs.kb_id
      && identifier(s.knowledge_id) && typeof s.content === 'string' && typeof s.knowledge_title === 'string')
    if (!source) { unverified = true; return '[未验证引用]' }
    let citation = citations.find(c => c.chunkId === source.chunk_id && c.knowledgeBaseId === source.knowledge_base_id)
    if (!citation) {
      citation = { number: citations.length + 1, knowledgeBaseId: String(source.knowledge_base_id), knowledgeId: String(source.knowledge_id),
        chunkId: String(source.chunk_id), title: String(source.knowledge_title), content: String(source.content),
        chunkIndex: source.chunk_index as string | number | undefined, level: 'same-turn-search' }
      citations.push(citation)
    }
    return `[${citation.number}]`
  }).replace(/resource:\/\/[^\s<>"')\]]+/g, '图片资源未接入').replace(/</g, '&lt;')
  return { body, citations, citationStatus: unverified ? 'unverified' : citations.length ? 'verified' : 'none' }
}
