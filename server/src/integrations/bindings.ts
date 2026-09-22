import type { Pool } from 'pg'

export type CapabilityKind = 'tool' | 'agent-service'
export type CapabilityId = 'weknora.search' | 'weknora.agent' | 'a2a.agent' | 'mcp.tools'

export interface BindingActor { companyId: string | null; subjectId: string }
export interface IntegrationConnection {
  id: string; version: string; kind: CapabilityKind; backend: 'weknora' | 'a2a' | 'mcp'
  baseUrl: string; secretRef: string; credentialRevision: string; knowledgeBaseIds: string[]; enabled: boolean
}
interface BindingBase {
  id: string; version: string; connectionId: string; connectionVersion: string
  companyIds: string[]; subjectIds: string[]; enabled: boolean
}
/** Operator attestation of the effective remote configuration, not model input. */
export interface AgentApproval {
  authorizationVersion: string; tenantId: string; effectiveConfigDigest: string
  mode: 'smart-reasoning'; allowedTools: string[]; credentialCapability: 'chat'; kbSelectionMode: 'selected'
  retrieveKbOnlyWhenMentioned: false; mcpSelectionMode: 'none' | 'all'; mcpEnabledServiceIds?: string[]
  skillsSelectionMode: 'none'; sandboxEnabled: false; memoryEnabled: false
}
export interface A2AApproval {
  authorizationVersion: string; tenantId: string; effectiveConfigDigest: string
  cardSha256: string; protocolVersion: '0.3.0'
}
export interface McpToolApproval {
  name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; readOnly: true
}
export type IntegrationBinding = BindingBase & (
  | { kind: 'tool'; capabilityId: 'weknora.search'; knowledgeBaseId: string }
  | { kind: 'agent-service'; capabilityId: 'weknora.agent'; remoteAgentId: string; approval?: AgentApproval }
  | { kind: 'agent-service'; capabilityId: 'a2a.agent'; remoteAgentId: string; approval?: A2AApproval }
  | { kind: 'tool'; capabilityId: 'mcp.tools'; tools: McpToolApproval[] }
)
export interface BindingConfig { schemaVersion: 1; connections: IntegrationConnection[]; bindings: IntegrationBinding[] }
export type BindingDenialCode =
  | 'invalid_config' | 'duplicate_id' | 'version_conflict' | 'missing_connection'
  | 'scope_denied' | 'missing_binding' | 'disabled' | 'kind_mismatch'
  | 'invalid_actor' | 'company_denied' | 'subject_denied' | 'ambiguous_binding'
  | 'missing_secret' | 'unavailable'
/** Internal server value. Never serialize credentials into CLI results or audit events. */
export interface ResolvedSearchBinding {
  readonly id: string; readonly version: string; readonly connectionId: string; readonly connectionVersion: string
  readonly baseUrl: string; readonly apiKey: string; readonly knowledgeBaseId: string
}
export interface ResolvedAgentBinding extends Omit<ResolvedSearchBinding, 'knowledgeBaseId'> {
  readonly backend: 'weknora'
  readonly remoteAgentId: string; readonly knowledgeBaseIds: readonly string[]
  readonly approval: Readonly<Omit<AgentApproval, 'allowedTools' | 'mcpEnabledServiceIds'> & { allowedTools: readonly string[]; mcpEnabledServiceIds?: readonly string[] }>
}
export interface ResolvedA2ABinding extends Omit<ResolvedSearchBinding, 'knowledgeBaseId'> {
  readonly backend: 'a2a'
  readonly remoteAgentId: string; readonly knowledgeBaseIds: readonly string[]; readonly approval: Readonly<A2AApproval>
}
export type ResolvedExternalAgentBinding = ResolvedAgentBinding | ResolvedA2ABinding
export interface ResolvedMcpBinding extends Omit<ResolvedSearchBinding, 'knowledgeBaseId'> {
  readonly backend: 'mcp'; readonly tools: readonly McpToolApproval[]
}
export type BindingResolution<T = ResolvedSearchBinding> = { ok: true; binding: T } | { ok: false; code: BindingDenialCode }
/** Runtime resolves the current database configuration at every authorization checkpoint. */
export type BindingProvider = (actor: BindingActor, db?: Pick<Pool, 'query'>) => Promise<BindingResolver | undefined>
export class BindingConfigError extends Error {
  constructor(readonly code: BindingDenialCode) { super(`integration binding: ${code}`) }
}
function requireConfig(condition: unknown): asserts condition { if (!condition) throw new BindingConfigError('invalid_config') }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(nonempty) }
function freezeConfig(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeConfig(child)
    Object.freeze(value)
  }
}
/** One immutable operator-owned snapshot; it grants no member execution rights. */
export class BindingResolver {
  #config: BindingConfig
  #secrets: Readonly<Record<string, string>>
  #versions: Map<string, string>
  #credentials: Map<string, string>
  #retired = false
  constructor(config: BindingConfig, secrets: Readonly<Record<string, string>>, previous?: BindingResolver) {
    requireConfig(config && config.schemaVersion === 1 && Array.isArray(config.connections) && Array.isArray(config.bindings))
    if (previous && previous.#retired) throw new BindingConfigError('version_conflict')
    this.#versions = new Map(previous ? previous.#versions : undefined)
    this.#credentials = new Map(previous ? previous.#credentials : undefined)
    const ids = new Set<string>()
    const remember = (type: string, id: string, version: string, values: unknown[]) => {
      const identity = JSON.stringify([type, id])
      if (ids.has(identity)) throw new BindingConfigError('duplicate_id')
      ids.add(identity)
      const key = JSON.stringify([type, id, version]), content = JSON.stringify(values)
      if (this.#versions.has(key) && this.#versions.get(key) !== content) throw new BindingConfigError('version_conflict')
      this.#versions.set(key, content)
    }
    for (const c of config.connections) {
      requireConfig(c && [c.id, c.version, c.baseUrl, c.secretRef, c.credentialRevision].every(nonempty)
        && (c.kind === 'tool' || c.kind === 'agent-service') && ['weknora', 'a2a', 'mcp'].includes(c.backend)
        && typeof c.enabled === 'boolean' && strings(c.knowledgeBaseIds))
      let url: URL
      try { url = new URL(c.baseUrl) } catch { throw new BindingConfigError('invalid_config') }
      requireConfig(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
      if (c.backend !== 'weknora') requireConfig(['127.0.0.1', '[::1]'].includes(url.hostname)
        && c.knowledgeBaseIds.length === 0 && c.kind === (c.backend === 'a2a' ? 'agent-service' : 'tool'))
      remember('connection', c.id, c.version, [c.kind, c.backend, c.baseUrl, c.secretRef, c.credentialRevision, [...c.knowledgeBaseIds].sort(), c.enabled])
      const secret = Object.hasOwn(secrets, c.secretRef) ? secrets[c.secretRef] : undefined
      if (secret !== undefined) {
        requireConfig(typeof secret === 'string')
        const credential = JSON.stringify([c.secretRef, c.credentialRevision])
        if (this.#credentials.has(credential) && this.#credentials.get(credential) !== secret) throw new BindingConfigError('version_conflict')
        this.#credentials.set(credential, secret)
      }
    }
    for (const b of config.bindings) {
      requireConfig(b && [b.id, b.version, b.connectionId, b.connectionVersion].every(nonempty)
        && typeof b.enabled === 'boolean' && strings(b.companyIds) && strings(b.subjectIds))
      requireConfig((b.kind === 'tool' && b.capabilityId === 'weknora.search' && nonempty(b.knowledgeBaseId))
        || (b.kind === 'agent-service' && ['weknora.agent', 'a2a.agent'].includes(b.capabilityId) && nonempty(b.remoteAgentId))
        || (b.kind === 'tool' && b.capabilityId === 'mcp.tools' && Array.isArray(b.tools)))
      const c = config.connections.find(item => item.id === b.connectionId)
      if (c) requireConfig(c.backend === b.capabilityId.split('.')[0])
      let approvalIdentity: unknown = null
      if (b.capabilityId === 'weknora.agent' && b.approval) {
        const a = b.approval
        requireConfig(a.mode === 'smart-reasoning' && a.credentialCapability === 'chat'
          && nonempty(a.authorizationVersion) && nonempty(a.tenantId) && /^[a-f0-9]{64}$/.test(a.effectiveConfigDigest)
          && strings(a.allowedTools) && a.allowedTools.length > 0
          && a.allowedTools.every(tool => ['knowledge_search', 'grep_chunks', 'list_knowledge_chunks', 'query_knowledge_graph', 'get_document_info'].includes(tool))
          && a.kbSelectionMode === 'selected' && a.retrieveKbOnlyWhenMentioned === false
          && (a.mcpSelectionMode === 'none' || a.mcpSelectionMode === 'all')
          && (Object.hasOwn(a, 'mcpEnabledServiceIds') ? Array.isArray(a.mcpEnabledServiceIds) && a.mcpEnabledServiceIds.length === 0 : a.mcpSelectionMode === 'none')
          && a.skillsSelectionMode === 'none' && a.sandboxEnabled === false && a.memoryEnabled === false
          && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(b.remoteAgentId))
        if (c) {
          const url = new URL(c.baseUrl)
          requireConfig(['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/api/v1'
            && c.knowledgeBaseIds.length > 0 && !config.connections.some(other => other.kind === 'tool' && other.secretRef === c.secretRef))
        }
        approvalIdentity = [a.authorizationVersion, a.tenantId, a.effectiveConfigDigest, a.mode,
          [...new Set(a.allowedTools)].sort(), a.credentialCapability, a.kbSelectionMode,
          a.retrieveKbOnlyWhenMentioned, a.mcpSelectionMode, a.mcpEnabledServiceIds ?? null,
          a.skillsSelectionMode, a.sandboxEnabled, a.memoryEnabled]
      }
      if (b.capabilityId === 'a2a.agent' && b.approval) {
        const a = b.approval
        requireConfig(nonempty(a.authorizationVersion) && nonempty(a.tenantId) && a.protocolVersion === '0.3.0'
          && /^[a-f0-9]{64}$/.test(a.cardSha256) && a.effectiveConfigDigest === a.cardSha256
          && /^[a-zA-Z0-9._-]{1,128}$/.test(b.remoteAgentId))
        approvalIdentity = [a.authorizationVersion, a.tenantId, a.effectiveConfigDigest, a.cardSha256, a.protocolVersion]
      }
      if (b.capabilityId === 'mcp.tools') {
        requireConfig(b.tools.length > 0 && b.tools.length <= 64 && new Set(b.tools.map(t => t?.name)).size === b.tools.length)
        for (const t of b.tools) requireConfig(t && /^[a-zA-Z0-9_.-]{1,128}$/.test(t.name) && t.readOnly === true
          && t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) && t.inputSchema.type === 'object'
          && (t.outputSchema === undefined || (t.outputSchema && typeof t.outputSchema === 'object' && !Array.isArray(t.outputSchema) && t.outputSchema.type === 'object')))
        approvalIdentity = [...b.tools].sort((a, other) => a.name.localeCompare(other.name))
      }
      remember('binding', b.id, b.version, [b.kind, b.capabilityId, b.connectionId, b.connectionVersion,
        [...b.companyIds].sort(), [...b.subjectIds].sort(), b.enabled,
        b.capabilityId === 'weknora.search' ? b.knowledgeBaseId : b.capabilityId === 'mcp.tools' ? approvalIdentity : [b.remoteAgentId, approvalIdentity]])
    }
    this.#config = structuredClone(config)
    freezeConfig(this.#config)
    this.#secrets = { ...secrets }
    if (previous) previous.#retired = true
  }

  /** Exactly one primary external service, irrespective of its protocol. */
  resolveAgent(actor: BindingActor): BindingResolution<ResolvedExternalAgentBinding> {
    const matches = this.#config.bindings.filter(b => b.kind === 'agent-service' && b.companyIds.includes(actor.companyId ?? '') && b.subjectIds.includes(actor.subjectId))
    if (matches.length > 1) return { ok: false, code: 'ambiguous_binding' }
    const capability = matches[0]?.capabilityId
    return capability === 'a2a.agent' ? this.resolve(actor, capability, 'agent-service') : this.resolve(actor, 'weknora.agent', 'agent-service')
  }
  resolve(actor: BindingActor, capabilityId: 'weknora.search', kind: CapabilityKind): BindingResolution
  resolve(actor: BindingActor, capabilityId: 'weknora.agent', kind: CapabilityKind): BindingResolution<ResolvedAgentBinding>
  resolve(actor: BindingActor, capabilityId: 'a2a.agent', kind: CapabilityKind): BindingResolution<ResolvedA2ABinding>
  resolve(actor: BindingActor, capabilityId: 'mcp.tools', kind: CapabilityKind): BindingResolution<ResolvedMcpBinding>
  resolve(actor: BindingActor, capabilityId: CapabilityId, kind: CapabilityKind): BindingResolution<ResolvedSearchBinding | ResolvedExternalAgentBinding | ResolvedMcpBinding> {
    const deny = (code: BindingDenialCode): BindingResolution<never> => ({ ok: false, code })
    if (this.#retired) return deny('version_conflict')
    if (!actor.companyId || !actor.subjectId) return deny('invalid_actor')
    const candidates = this.#config.bindings.filter(binding => binding.capabilityId === capabilityId)
    if (!candidates.length) return deny('missing_binding')
    const companies = candidates.filter(binding => binding.companyIds.includes(actor.companyId!))
    if (!companies.length) return deny('company_denied')
    const matches = companies.filter(binding => binding.subjectIds.includes(actor.subjectId))
    if (!matches.length) return deny('subject_denied')
    if (matches.length !== 1) return deny('ambiguous_binding')
    const binding = matches[0], connection = this.#config.connections.find(item => item.id === binding.connectionId)
    if (!connection) return deny('missing_connection')
    if (!binding.enabled || !connection.enabled) return deny('disabled')
    if (binding.kind !== kind || connection.kind !== kind) return deny('kind_mismatch')
    if (binding.connectionVersion !== connection.version) return deny('version_conflict')
    if (binding.kind === 'agent-service' && !binding.approval) return deny('unavailable')
    if (binding.capabilityId === 'weknora.search' && !connection.knowledgeBaseIds.includes(binding.knowledgeBaseId)) return deny('scope_denied')
    const apiKey = Object.hasOwn(this.#secrets, connection.secretRef) ? this.#secrets[connection.secretRef] : undefined
    if (!nonempty(apiKey)) return deny('missing_secret')
    const common = { id: binding.id, version: binding.version, connectionId: connection.id, connectionVersion: connection.version, baseUrl: connection.baseUrl, apiKey }
    if (binding.capabilityId === 'weknora.search') {
      return { ok: true, binding: Object.freeze({ ...common, knowledgeBaseId: binding.knowledgeBaseId }) }
    }
    if (binding.capabilityId === 'mcp.tools') return { ok: true, binding: Object.freeze({ ...common, backend: 'mcp', tools: binding.tools }) }
    if (!binding.approval) return deny('unavailable')
    if (binding.capabilityId === 'a2a.agent') return { ok: true, binding: Object.freeze({ ...common, backend: 'a2a', remoteAgentId: binding.remoteAgentId, knowledgeBaseIds: connection.knowledgeBaseIds, approval: binding.approval }) }
    return { ok: true, binding: Object.freeze({ ...common, backend: 'weknora', remoteAgentId: binding.remoteAgentId, knowledgeBaseIds: connection.knowledgeBaseIds, approval: binding.approval }) }
  }
}
