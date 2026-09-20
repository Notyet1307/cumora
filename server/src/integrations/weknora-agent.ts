import type { ResolvedAgentBinding } from './bindings.js'

export interface RemoteIds {
  sessionId: string
  assistantMessageId: string
  userMessageId: string
  remoteRequestId: string
  [key: string]: string
}
export interface AgentResult {
  status: 'completed' | 'failed' | 'unknown'
  answer: string
  references: unknown[]
  ids: RemoteIds | null
  usage: Record<string, unknown> | null
  cost: null
  evidence: { complete: boolean; stop: boolean; error: boolean }
  limitations: string[]
  [key: string]: unknown
}
export const AGENT_LIMITS = Object.freeze({ inputChars: 8000, responseBytes: 8 * 1024 * 1024, frameBytes: 1024 * 1024, firstResponseMs: 30_000, totalMs: 180_000 })
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

function initialResult(): AgentResult {
  return { status: 'unknown', answer: '', references: [], ids: null, usage: null, cost: null,
    evidence: { complete: false, stop: false, error: false }, limitations: [] }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('read_aborted')); signal.addEventListener('abort', onAbort, { once: true }) })
  try { return await Promise.race([operation, aborted]) } finally { signal.removeEventListener('abort', onAbort) }
}

/** A complete stream is evidence; neither answer.done nor socket EOF is completion. */
export async function readAgentStream(
  body: ReadableStream<Uint8Array>, sessionId: string, onIds: (ids: RemoteIds) => Promise<void>,
  options: { signal?: AbortSignal; expectedIds?: RemoteIds; maxBytes?: number; maxFrameBytes?: number } = {},
): Promise<AgentResult> {
  const result = initialResult()
  const signal = options.signal ?? AbortSignal.timeout(AGENT_LIMITS.totalMs)
  const maxBytes = Math.min(options.maxBytes ?? AGENT_LIMITS.responseBytes, AGENT_LIMITS.responseBytes)
  const maxFrame = Math.min(options.maxFrameBytes ?? AGENT_LIMITS.frameBytes, AGENT_LIMITS.frameBytes)
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '', event = '', data: string[] = [], frameBytes = 0, totalBytes = 0, broken = false
  // Deployed AgentStreamHandler composes non-superseded segments in first-arrival order.
  const answers = new Map<string, { content: string; superseded: boolean }>()
  const activeTools = new Set<string>()
  const limitation = (code: string) => { if (!result.limitations.includes(code) && result.limitations.length < 32) result.limitations.push(code) }
  const frame = async () => {
    if (!data.length) return
    if (event && event !== 'message') { limitation('unsupported_sse_event'); return }
    const value = object(JSON.parse(data.join('\n')))
    if (!value || typeof value.response_type !== 'string') throw new Error('malformed_event')
    const detail = object(value.data) ?? {}
    if ((value.response_type === 'tool_result' || (value.response_type === 'error' && value.done === false)) && id(detail.tool_call_id)) activeTools.delete(detail.tool_call_id)
    if (value.session_id !== undefined && value.session_id !== sessionId) throw new Error('session_drift')
    if (result.ids && value.assistant_message_id !== undefined && value.assistant_message_id !== result.ids.assistantMessageId) throw new Error('message_drift')
    if (result.ids && value.id !== undefined && value.id !== result.ids.remoteRequestId) throw new Error('request_drift')
    if (value.response_type === 'agent_query') {
      if (value.done !== true || (detail.session_id !== undefined && detail.session_id !== sessionId)
        || (detail.assistant_message_id !== undefined && value.assistant_message_id !== undefined && detail.assistant_message_id !== value.assistant_message_id)) throw new Error('invalid_query_metadata')
      const ids = { sessionId: value.session_id ?? detail.session_id, assistantMessageId: value.assistant_message_id ?? detail.assistant_message_id,
        userMessageId: detail.user_message_id, remoteRequestId: value.id }
      if (!Object.values(ids).every(id) || ids.sessionId !== sessionId) throw new Error('invalid_ids')
      const valid = ids as RemoteIds
      for (const expected of [result.ids, options.expectedIds]) {
        if (expected && Object.keys(valid).some(key => expected[key] !== valid[key])) throw new Error('id_drift')
      }
      result.ids = valid
      await onIds(valid)
    } else if (value.response_type === 'answer') {
      if (result.evidence.complete) throw new Error('answer_after_complete')
      if (value.content !== undefined && typeof value.content !== 'string') throw new Error('invalid_answer')
      if (!id(detail.event_id)) throw new Error('invalid_answer_event_id')
      if (value.content) {
        const segment = answers.get(detail.event_id)
        if (!segment) answers.set(detail.event_id, { content: value.content as string, superseded: false })
        else if (!segment.superseded) segment.content += value.content
      }
    } else if (value.response_type === 'tool_call') {
      if (!id(detail.tool_call_id)) throw new Error('invalid_tool_call_id')
      if (!activeTools.has(detail.tool_call_id)) {
        activeTools.add(detail.tool_call_id)
        for (const segment of answers.values()) {
          if (segment.content) { segment.superseded = true; segment.content = '' }
        }
      }
    } else if (value.response_type === 'references') {
      const refs = value.knowledge_references ?? detail.references
      if (!Array.isArray(refs)) throw new Error('invalid_references')
      result.references = refs
    } else if (value.response_type === 'complete') {
      if (!result.ids || value.done !== true) throw new Error('invalid_complete')
      result.evidence.complete = true
      const usage = object(value.usage) ?? object(detail.usage)
      if (usage) result.usage = usage
      if (Array.isArray(detail.artifacts) && detail.artifacts.length) limitation('artifacts_not_downloaded')
    } else if (value.response_type === 'stop') {
      result.evidence.stop = true
      limitation('remote_stop_observed_not_rollback')
    } else if (value.response_type === 'error') {
      if (value.done === true) result.evidence.error = true
      else if (value.done !== false) throw new Error('ambiguous_error')
      limitation(value.done ? 'remote_terminal_error' : 'nonterminal_tool_diagnostic')
    } else {
      // Never retain thinking, tool_result, remote URLs, or approval payloads.
      if (/approval|input_required|authorization/.test(value.response_type)) broken = true
      limitation('unsupported_progress_or_artifact')
    }
  }
  try {
    while (true) {
      const part = await abortable(reader.read(), signal)
      if (part.done) { pending += decoder.decode(); break }
      totalBytes += part.value.byteLength
      if (totalBytes > maxBytes) throw new Error('response_limit')
      pending += decoder.decode(part.value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) !== -1) {
        const rawLine = pending.slice(0, newline)
        const line = rawLine.replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        frameBytes += Buffer.byteLength(rawLine) + 1
        if (frameBytes > maxFrame) throw new Error('frame_limit')
        if (!line) { await frame(); data = []; event = ''; frameBytes = 0; continue }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const content = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'data') data.push(content)
        else if (field === 'event') event = content
      }
      if (frameBytes + Buffer.byteLength(pending) > maxFrame) throw new Error('frame_limit')
    }
    if (pending || data.length) throw new Error('incomplete_frame')
  } catch {
    broken = true
    limitation('incomplete_or_invalid_stream')
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  for (const segment of answers.values()) if (!segment.superseded) result.answer += segment.content
  if (!broken && result.evidence.complete && !result.evidence.stop && !result.evidence.error) result.status = 'completed'
  if (!broken && result.evidence.error && !result.evidence.complete && !result.evidence.stop) result.status = 'failed'
  if (!result.evidence.complete) limitation('no_reliable_terminal')
  if (result.evidence.complete && !result.references.length) limitation('upstream_provided_no_references')
  return result
}

/** Only fixed operator-selected loopback origins; redirects and arbitrary resource fetches never run. */
export class WeknoraAgentClient {
  readonly #binding: ResolvedAgentBinding
  readonly #authorize: () => void | Promise<void>
  constructor(binding: ResolvedAgentBinding, authorize: () => void | Promise<void>) {
    this.#binding = binding
    this.#authorize = authorize
    const url = new URL(binding.baseUrl)
    if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/api/v1'
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('unapproved_origin')
  }

  async #request(path: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    await this.#authorize()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AGENT_LIMITS.firstResponseMs)
    try {
      const response = await fetch(this.#binding.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
        headers: { 'X-API-Key': this.#binding.apiKey, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) { void response.body?.cancel(); throw new Error('remote_http_failure') }
      return response
    } catch { throw new Error('remote_request_unconfirmed') } finally { clearTimeout(timer) }
  }

  async #json(response: Response, signal: AbortSignal, maxBytes: number = AGENT_LIMITS.frameBytes): Promise<Record<string, unknown>> {
    if (!response.body) throw new Error('missing_response_body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const item = await abortable(reader.read(), signal)
        if (item.done) break
        size += item.value.byteLength
        if (size > maxBytes) throw new Error('session_response_limit')
        chunks.push(item.value)
      }
      const parsed = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!parsed) throw new Error('invalid_json_response')
      return parsed
    } catch { throw new Error('invalid_or_incomplete_json_response') }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }

  async createSession(signal: AbortSignal): Promise<string> {
    const response = await this.#request('/sessions', signal, { title: 'Cumora controlled probe', description: 'Synthetic operator probe' })
    const parsed = await this.#json(response, signal)
    const sessionId = object(parsed.data)?.id
    if (!id(sessionId) || sessionId.includes(this.#binding.apiKey)) throw new Error('invalid_session_id')
    return sessionId
  }

  /** Only this owned Session's last pair; member serialization protects the window. */
  async history(ids: RemoteIds, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!Object.values(ids).every(id)) throw new Error('invalid_ids')
    const response = await this.#request(`/messages/${encodeURIComponent(ids.sessionId)}/load?limit=2`, signal)
    const value = await this.#json(response, signal, AGENT_LIMITS.responseBytes)
    if (JSON.stringify(value).includes(this.#binding.apiKey)) throw new Error('credential_echo_in_history')
    return value
  }

  async stop(ids: RemoteIds, signal: AbortSignal): Promise<{ accepted: boolean }> {
    if (!Object.values(ids).every(id)) throw new Error('invalid_ids')
    const response = await this.#request(`/sessions/${encodeURIComponent(ids.sessionId)}/stop`, signal, { message_id: ids.assistantMessageId })
    const value = await this.#json(response, signal)
    return { accepted: value.success === true }
  }

  async submit(sessionId: string, query: string, onIds: (ids: RemoteIds) => Promise<void>, signal: AbortSignal): Promise<AgentResult> {
    if (!id(sessionId) || !query.trim() || query.length > AGENT_LIMITS.inputChars) throw new Error('invalid_probe')
    const response = await this.#request(`/agent-chat/${encodeURIComponent(sessionId)}`, signal, {
      query, agent_id: this.#binding.remoteAgentId, agent_enabled: true, web_search_enabled: false,
      disable_title: true, channel: 'api', knowledge_base_ids: this.#binding.knowledgeBaseIds,
    })
    return this.#stream(response, sessionId, onIds, signal)
  }

  async observe(ids: RemoteIds, onIds: (ids: RemoteIds) => Promise<void>, signal: AbortSignal): Promise<AgentResult> {
    if (!Object.values(ids).every(id)) throw new Error('invalid_ids')
    const response = await this.#request(`/sessions/continue-stream/${encodeURIComponent(ids.sessionId)}?message_id=${encodeURIComponent(ids.assistantMessageId)}`, signal)
    return this.#stream(response, ids.sessionId, onIds, signal, ids)
  }

  async #stream(response: Response, sessionId: string, onIds: (ids: RemoteIds) => Promise<void>, signal: AbortSignal, expectedIds?: RemoteIds): Promise<AgentResult> {
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('invalid_stream_response')
    const result = await readAgentStream(response.body, sessionId, async ids => {
      if (Object.values(ids).some(value => value.includes(this.#binding.apiKey))) throw new Error('credential_echo_in_ids')
      await onIds(ids)
    }, { signal, expectedIds })
    // Redact decoded strings, not JSON bytes: quoted/backslashed secrets must also disappear.
    const redact = (value: unknown): unknown => {
      if (typeof value === 'string') return value.split(this.#binding.apiKey).join('[redacted]')
      if (Array.isArray(value)) return value.map(redact)
      const record = object(value)
      return record ? Object.fromEntries(Object.entries(record).map(([key, v]) => [key.split(this.#binding.apiKey).join('[redacted]'), redact(v)])) : value
    }
    return redact(result) as AgentResult
  }
}
