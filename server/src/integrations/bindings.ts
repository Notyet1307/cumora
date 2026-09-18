export type CapabilityKind = 'tool' | 'agent-service'
export type CapabilityId = 'weknora.search' | 'weknora.agent'

export interface BindingActor {
  companyId: string | null
  subjectId: string
}

export interface IntegrationConnection {
  id: string
  version: string
  kind: CapabilityKind
  backend: 'weknora'
  baseUrl: string
  secretRef: string
  credentialRevision: string
  knowledgeBaseIds: string[]
  enabled: boolean
}

interface BindingBase {
  id: string
  version: string
  connectionId: string
  connectionVersion: string
  companyIds: string[]
  subjectIds: string[]
  enabled: boolean
}

export type IntegrationBinding = BindingBase & (
  | { kind: 'tool'; capabilityId: 'weknora.search'; knowledgeBaseId: string }
  | { kind: 'agent-service'; capabilityId: 'weknora.agent'; remoteAgentId: string }
)

export interface BindingConfig {
  schemaVersion: 1
  connections: IntegrationConnection[]
  bindings: IntegrationBinding[]
}

export type BindingDenialCode =
  | 'invalid_config' | 'duplicate_id' | 'version_conflict' | 'missing_connection'
  | 'scope_denied' | 'missing_binding' | 'disabled' | 'kind_mismatch'
  | 'invalid_actor' | 'company_denied' | 'subject_denied' | 'ambiguous_binding'
  | 'missing_secret' | 'unavailable'

/** Internal server value. Never serialize it into a CLI result or audit event. */
export interface ResolvedSearchBinding {
  readonly id: string
  readonly version: string
  readonly connectionId: string
  readonly connectionVersion: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly knowledgeBaseId: string
}

export type BindingResolution =
  | { ok: true; binding: ResolvedSearchBinding }
  | { ok: false; code: BindingDenialCode }

export class BindingConfigError extends Error {
  constructor(readonly code: BindingDenialCode) {
    super(`integration binding: ${code}`)
  }
}

function requireConfig(condition: unknown): asserts condition {
  if (!condition) throw new BindingConfigError('invalid_config')
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty)
}

/** One immutable operator-owned snapshot; it grants no member execution rights. */
export class BindingResolver {
  #config: BindingConfig
  #secrets: Readonly<Record<string, string>>
  #versions: Map<string, string>
  #credentials: Map<string, string>
  #retired = false

  /** Previous snapshots preserve version identities, not mutable runtime overrides. */
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
      const key = JSON.stringify([type, id, version])
      const content = JSON.stringify(values)
      if (this.#versions.has(key) && this.#versions.get(key) !== content) throw new BindingConfigError('version_conflict')
      this.#versions.set(key, content)
    }
    for (const c of config.connections) {
      requireConfig(c && [c.id, c.version, c.baseUrl, c.secretRef, c.credentialRevision].every(nonempty)
        && (c.kind === 'tool' || c.kind === 'agent-service') && c.backend === 'weknora'
        && typeof c.enabled === 'boolean' && strings(c.knowledgeBaseIds))
      let url: URL
      try { url = new URL(c.baseUrl) } catch { throw new BindingConfigError('invalid_config') }
      requireConfig(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
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
        || (b.kind === 'agent-service' && b.capabilityId === 'weknora.agent' && nonempty(b.remoteAgentId)))
      remember('binding', b.id, b.version, [b.kind, b.capabilityId, b.connectionId, b.connectionVersion,
        [...b.companyIds].sort(), [...b.subjectIds].sort(), b.enabled, b.kind === 'tool' ? b.knowledgeBaseId : b.remoteAgentId])
    }
    this.#config = structuredClone(config)
    this.#secrets = { ...secrets }
    if (previous) previous.#retired = true
  }

  resolve(actor: BindingActor, capabilityId: CapabilityId, kind: CapabilityKind): BindingResolution {
    const deny = (code: BindingDenialCode): BindingResolution => ({ ok: false, code })
    if (this.#retired) return deny('version_conflict')
    if (!actor.companyId || !actor.subjectId) return deny('invalid_actor')
    const candidates = this.#config.bindings.filter((binding) => binding.capabilityId === capabilityId)
    if (!candidates.length) return deny('missing_binding')
    const companies = candidates.filter((binding) => binding.companyIds.includes(actor.companyId!))
    if (!companies.length) return deny('company_denied')
    const matches = companies.filter((binding) => binding.subjectIds.includes(actor.subjectId))
    if (!matches.length) return deny('subject_denied')
    if (matches.length !== 1) return deny('ambiguous_binding')
    const binding = matches[0]
    const connection = this.#config.connections.find((item) => item.id === binding.connectionId)
    if (!connection) return deny('missing_connection')
    if (!binding.enabled || !connection.enabled) return deny('disabled')
    if (binding.kind !== kind || connection.kind !== kind) return deny('kind_mismatch')
    if (binding.connectionVersion !== connection.version) return deny('version_conflict')
    if (binding.kind === 'agent-service') return deny('unavailable')
    if (!connection.knowledgeBaseIds.includes(binding.knowledgeBaseId)) return deny('scope_denied')
    const apiKey = Object.hasOwn(this.#secrets, connection.secretRef) ? this.#secrets[connection.secretRef] : undefined
    if (!nonempty(apiKey)) return deny('missing_secret')
    return { ok: true, binding: Object.freeze({
      id: binding.id, version: binding.version,
      connectionId: connection.id, connectionVersion: connection.version,
      baseUrl: connection.baseUrl, apiKey, knowledgeBaseId: binding.knowledgeBaseId,
    }) }
  }
}
