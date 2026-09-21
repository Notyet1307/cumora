import { createHash } from 'node:crypto'
import { DefaultAgentCardResolver, JsonRpcTransport } from '@a2a-js/sdk/client'
import type { ResolvedA2ABinding } from './bindings.js'
import { createProtocolFetch } from './protocol-http.js'
import { AGENT_LIMITS } from './weknora-agent.js'

const CARD_PATH = '/.well-known/agent-card.json'
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const textModes = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(mode => mode === 'text/plain' || mode === 'text/markdown')

/** Digest contract: SHA-256 of UTF-8 canonical JSON, recursively sorting object keys by
 * JavaScript UTF-16 lexicographic order, preserving array order, and encoding JSON
 * primitives with JSON.stringify. No whitespace, omitted fields, or Unicode normalization.
 * This is a deliberately specified JSON contract, not a claim of RFC 8785 compliance. */
export function a2aCardSha256(card: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    const record = object(value)
    if (record) return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    throw new Error('a2a_invalid_card_json')
  }
  return createHash('sha256').update(canonical(card), 'utf8').digest('hex')
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret)
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secret))
  const record = object(value)
  return record !== null && Object.entries(record).some(([key, item]) => key.includes(secret) || containsSecret(item, secret))
}

function bearerSecurity(value: unknown, schemes: Record<string, unknown>): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(requirement => {
    const entry = object(requirement)
    if (!entry || Object.keys(entry).length !== 1) return false
    const [name, scopes] = Object.entries(entry)[0]
    const scheme = object(schemes[name])
    return Array.isArray(scopes) && scopes.length === 0 && scheme?.type === 'http'
      && typeof scheme.scheme === 'string' && scheme.scheme.toLowerCase() === 'bearer'
  })
}

function approvedCard(value: unknown, binding: ResolvedA2ABinding): Record<string, unknown> {
  const card = object(value)
  if (!card || containsSecret(card, binding.apiKey) || a2aCardSha256(card) !== binding.approval.cardSha256
    || binding.approval.effectiveConfigDigest !== binding.approval.cardSha256
    || card.protocolVersion !== '0.3.0' || binding.approval.protocolVersion !== '0.3.0'
    || card.url !== binding.baseUrl || (card.preferredTransport !== undefined && card.preferredTransport !== 'JSONRPC')
    || !['name', 'description', 'version'].every(key => typeof card[key] === 'string' && (card[key] as string).trim())
    || !textModes(card.defaultInputModes) || !textModes(card.defaultOutputModes)) throw new Error('a2a_card_rejected')
  const capabilities = object(card.capabilities)
  if (!capabilities || ['streaming', 'pushNotifications', 'stateTransitionHistory'].some(key => capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean')) throw new Error('a2a_capabilities_rejected')
  if (capabilities.extensions !== undefined && (!Array.isArray(capabilities.extensions)
    || capabilities.extensions.some(extension => !object(extension) || typeof extension.uri !== 'string' || (extension.required !== undefined && extension.required !== false)))) throw new Error('a2a_extension_rejected')
  if (card.additionalInterfaces !== undefined && (!Array.isArray(card.additionalInterfaces)
    || card.additionalInterfaces.some(entry => !object(entry) || entry.url !== binding.baseUrl || entry.transport !== 'JSONRPC'))) throw new Error('a2a_interface_rejected')
  const schemes = object(card.securitySchemes)
  if (!schemes || !bearerSecurity(card.security, schemes)) throw new Error('a2a_authentication_rejected')
  // A2A 0.3 has no standard skill selector in message/send. Do not invent a routing
  // extension: an approved endpoint must expose exactly the one approved skill.
  const skill = Array.isArray(card.skills) && card.skills.length === 1 ? object(card.skills[0]) : null
  if (!skill || skill.id !== binding.remoteAgentId || typeof skill.name !== 'string' || typeof skill.description !== 'string'
    || !Array.isArray(skill.tags) || !skill.tags.every(tag => typeof tag === 'string')
    || !textModes(skill.inputModes ?? card.defaultInputModes) || !textModes(skill.outputModes ?? card.defaultOutputModes)
    || (skill.security !== undefined && !bearerSecurity(skill.security, schemes))) throw new Error('a2a_skill_rejected')
  return capabilities
}

function textParts(value: unknown): string {
  if (!Array.isArray(value) || !value.length) throw new Error('a2a_missing_text')
  return value.map(part => {
    const entry = object(part)
    if (!entry || entry.kind !== 'text' || typeof entry.text !== 'string') throw new Error('a2a_nontext_output')
    return entry.text
  }).join('')
}

function agentMessage(value: unknown, expectedContext?: string, expectedTask?: string): { ids: Record<string, string>; text: string } {
  const message = object(value)
  if (!message || message.kind !== 'message' || message.role !== 'agent' || !id(message.messageId)
    || (message.contextId !== undefined && (!id(message.contextId) || (expectedContext !== undefined && message.contextId !== expectedContext)))
    || (message.taskId !== undefined && (!id(message.taskId) || (expectedTask !== undefined && message.taskId !== expectedTask)))) throw new Error('a2a_invalid_message')
  const ids: Record<string, string> = { messageId: message.messageId }
  if (id(message.contextId)) ids.contextId = message.contextId
  if (id(message.taskId)) ids.taskId = message.taskId
  return { ids, text: textParts(message.parts) }
}

export interface A2AAgentResult {
  status: 'completed' | 'failed' | 'unknown'
  answer: string
  ids: Record<string, string> | null
  usage: Record<string, unknown> | null
  cost: null
  references: unknown[]
  limitations: string[]
  validation: {
    ok: boolean
    evidence: {
      sources: unknown[]
      protocol: 'a2a/0.3.0'
      cardSha256: string
      advertisedCapabilities: Record<string, unknown>
      verifiedOperations: string[]
      terminalKind?: 'task' | 'message'
    }
  }
}

/** Only authenticated card discovery and one blocking message/send. No retries,
 * polling, resources, extended cards, subscriptions, cancellation, or input replies.
 * A direct agent Message is the protocol's immediate response, not a Task terminal;
 * a completed Task requires complete inline text artifacts (not status/history text). */
export class A2AAgentClient {
  readonly #binding: ResolvedA2ABinding
  readonly #authorize: () => void | Promise<void>
  constructor(binding: ResolvedA2ABinding, authorize: () => void | Promise<void>) {
    this.#binding = binding
    this.#authorize = authorize
    createProtocolFetch(binding.baseUrl, binding.apiKey, authorize, new AbortController().signal)
  }

  /** Discovery only: never sends a message or invokes a model. */
  async preflight(signal: AbortSignal): Promise<Record<string, unknown>> {
    const binding = this.#binding
    const cardFetch = createProtocolFetch(binding.baseUrl, binding.apiKey, this.#authorize,
      AbortSignal.any([signal, AbortSignal.timeout(AGENT_LIMITS.firstResponseMs)]), [CARD_PATH])
    const card = await new DefaultAgentCardResolver({ fetchImpl: cardFetch, path: CARD_PATH }).resolve(binding.baseUrl)
    return approvedCard(card, binding)
  }

  async submit(input: { input: string; messageId: string; contextId?: string }, onIds: (ids: Record<string, string>) => Promise<void>, signal: AbortSignal, onDispatch: () => void): Promise<A2AAgentResult> {
    if (typeof input.input !== 'string' || !input.input.trim() || input.input.length > AGENT_LIMITS.inputChars
      || !id(input.messageId) || (input.contextId !== undefined && !id(input.contextId))) throw new Error('a2a_invalid_input')
    const binding = this.#binding
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(AGENT_LIMITS.totalMs)])
    let dispatched = false
    const result: A2AAgentResult = {
      status: 'unknown', answer: '', ids: null, usage: null, cost: null, references: [],
      limitations: ['a2a_blocking_send_only', 'remote_capabilities_are_advertised_not_verified', 'remote_text_is_untrusted', 'upstream_sources_not_verified', 'remote_usage_and_cost_not_standardized', 'no_remote_cancel_subscribe_or_respond', 'single_approved_skill_endpoint_required'],
      validation: { ok: false, evidence: { sources: [], protocol: 'a2a/0.3.0', cardSha256: binding.approval.cardSha256, advertisedCapabilities: {}, verifiedOperations: [] } },
    }
    try {
      const capabilities = await this.preflight(boundedSignal)
      // Retain only known booleans, not remote extension instructions or URLs.
      result.validation.evidence.advertisedCapabilities = Object.fromEntries(['streaming', 'pushNotifications', 'stateTransitionHistory'].filter(key => capabilities[key] !== undefined).map(key => [key, capabilities[key]]))
      const guardedSend = createProtocolFetch(binding.baseUrl, binding.apiKey, async () => {
        await this.#authorize()
        boundedSignal.throwIfAborted()
        if (!dispatched) { onDispatch(); dispatched = true }
      }, boundedSignal)
      const transport = new JsonRpcTransport({ endpoint: binding.baseUrl, fetchImpl: async (request, init) => {
        const response = await guardedSend(request, init)
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('a2a_invalid_response')
        // SDK 0.3.10 logs but accepts mismatched JSON-RPC IDs. Enforce the response
        // trust boundary before SDK decoding; the SDK still owns all wire requests.
        const envelope = object(await response.clone().json())
        if (!envelope || envelope.jsonrpc !== '2.0' || envelope.id !== 1 || containsSecret(envelope, binding.apiKey)
          || ('error' in envelope) === ('result' in envelope)) throw new Error('a2a_invalid_envelope')
        return response
      } })
      const remote: unknown = await transport.sendMessage({
        message: { kind: 'message', role: 'user', messageId: input.messageId, ...(input.contextId ? { contextId: input.contextId } : {}), parts: [{ kind: 'text', text: input.input }] },
        configuration: { blocking: true, acceptedOutputModes: ['text/plain', 'text/markdown'], historyLength: 0 },
      }, { signal: boundedSignal }, 1)
      const value = object(remote)
      if (!value) throw new Error('a2a_invalid_result')
      if (value.kind === 'message') {
        const message = agentMessage(value, input.contextId)
        if (!message.text.trim()) throw new Error('a2a_empty_message')
        result.ids = message.ids
        result.answer = message.text
        await onIds(message.ids)
        result.status = 'completed'
        result.validation.evidence.terminalKind = 'message'
        result.limitations.push('direct_agent_message_not_task_terminal')
      } else if (value.kind === 'task') {
        const status = object(value.status)
        if (!id(value.id) || !id(value.contextId) || (input.contextId !== undefined && input.contextId !== value.contextId)
          || !status || !['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown'].includes(String(status.state))) throw new Error('a2a_invalid_task')
        const ids: Record<string, string> = { taskId: value.id, contextId: value.contextId }
        if (status.message !== undefined) ids.messageId = agentMessage(status.message, value.contextId, value.id).ids.messageId
        result.ids = ids
        await onIds(ids)
        if (value.artifacts !== undefined) {
          if (!Array.isArray(value.artifacts)) throw new Error('a2a_invalid_artifacts')
          const seen = new Set<string>()
          const artifacts = value.artifacts.map(artifact => {
            const entry = object(artifact)
            if (!entry || !id(entry.artifactId) || seen.has(entry.artifactId)) throw new Error('a2a_invalid_artifact')
            seen.add(entry.artifactId)
            return textParts(entry.parts)
          })
          result.answer = artifacts.join('\n\n')
        }
        if (status.state === 'failed') result.status = 'failed'
        else if (status.state === 'completed' && result.answer.trim()) result.status = 'completed'
        else result.limitations.push('no_usable_terminal_text_artifact')
        if (result.status !== 'unknown') result.validation.evidence.terminalKind = 'task'
      } else throw new Error('a2a_unrecognized_result')
      await this.#authorize()
      boundedSignal.throwIfAborted()
      result.validation.evidence.verifiedOperations = ['message/send']
      result.validation.ok = result.status === 'completed'
      return result
    } catch {
      if (!dispatched) throw new Error('a2a_preflight_rejected')
      result.status = 'unknown'
      result.validation.ok = false
      result.limitations.push('a2a_response_unconfirmed_or_invalid')
      return result
    }
  }
}
