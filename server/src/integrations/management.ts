import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { HttpError } from '../admin.js'
import { AgentCreationError, createAgentRecord } from '../agents/create.js'
import { companyTier, TIER_LIMITS } from '../tier.js'
import { BindingResolver, type BindingActor, type BindingConfig, type IntegrationBinding } from './bindings.js'
import { probeIntegration } from './connection-probe.js'
import { hasIntegrationCredential, isIntegrationLoopbackUrl, validateIntegrationTrust, type IntegrationTrustGrant } from './integration-trust.js'
import type { IntegrationManagementView, IntegrationProbeResult, IntegrationTarget } from '../../../src/integration-types.js'

export type { IntegrationTrustGrant } from './integration-trust.js'
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const MAX_CONFIG_BYTES = 192 * 1024
const EMPTY_CONFIG: BindingConfig = { schemaVersion: 1, connections: [], bindings: [] }
type Queryable = Pick<Pool, 'query'>
interface ConfigRow { revision: number; config: BindingConfig }
interface MemberRow {
  id: string; name: string; execution_kind: 'native' | 'external-service'; execution_enabled: boolean
  runtime_assignment_id: string; execution_binding_id: string | null; execution_binding_version: string | null
  execution_config_digest: string | null; departed_at: Date | null
}

function policy(condition: unknown): asserts condition {
  if (!condition) throw new HttpError(400, 'integration_invalid_policy')
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  policy(value && typeof value === 'object' && !Array.isArray(value))
  policy(Object.keys(value).every(key => required.includes(key) || optional.includes(key))
    && required.every(key => Object.hasOwn(value, key)))
  return value as Record<string, unknown>
}
function identifier(value: unknown): value is string { return typeof value === 'string' && ID.test(value) }
function idList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(identifier) && new Set(value).size === value.length
}
function revisionNumber(value: unknown): asserts value is number {
  policy(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2147483647)
}
function jsonSchema(value: unknown, depth = 0): void {
  policy(depth <= 32)
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') { policy(Number.isFinite(value)); return }
  if (typeof value === 'string') { policy(value.length <= 8192); return }
  policy(value && typeof value === 'object')
  policy(Object.keys(value).length <= 512)
  for (const child of Object.values(value)) jsonSchema(child, depth + 1)
}

/** Strict managed subset. Protocol JSON schemas are the only open-ended objects. */
function parseConfig(input: unknown, companyId: string): BindingConfig {
  const root = shape(input, ['schemaVersion', 'connections', 'bindings'])
  policy(root.schemaVersion === 1 && Array.isArray(root.connections) && root.connections.length <= 64
    && Array.isArray(root.bindings) && root.bindings.length <= 128)
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(input)) } catch { throw new HttpError(400, 'integration_invalid_policy') }
  policy(bytes <= MAX_CONFIG_BYTES)
  for (const entry of root.connections as unknown[]) {
    const c = shape(entry, ['id', 'version', 'kind', 'backend', 'baseUrl', 'secretRef', 'credentialRevision', 'knowledgeBaseIds', 'enabled'])
    policy([c.id, c.version, c.secretRef, c.credentialRevision].every(identifier)
      && ['weknora', 'a2a', 'mcp'].includes(String(c.backend)) && typeof c.enabled === 'boolean'
      && c.kind === (c.backend === 'mcp' ? 'tool' : 'agent-service')
      && isIntegrationLoopbackUrl(c.baseUrl) && idList(c.knowledgeBaseIds))
  }
  const subjects = new Set<string>()
  for (const entry of root.bindings as unknown[]) {
    policy(entry && typeof entry === 'object' && 'capabilityId' in entry)
    const capability = entry.capabilityId
    policy(capability === 'weknora.agent' || capability === 'a2a.agent' || capability === 'mcp.tools')
    const b = shape(entry, ['id', 'version', 'connectionId', 'connectionVersion', 'companyIds', 'subjectIds', 'enabled', 'kind', 'capabilityId',
      ...(capability === 'mcp.tools' ? ['tools'] : ['remoteAgentId', 'approval'])])
    policy([b.id, b.version, b.connectionId, b.connectionVersion].every(identifier)
      && idList(b.companyIds) && b.companyIds.length === 1 && b.companyIds[0] === companyId
      && idList(b.subjectIds) && b.subjectIds.length === 1 && typeof b.enabled === 'boolean'
      && b.kind === (capability === 'mcp.tools' ? 'tool' : 'agent-service'))
    const subjectId = (b.subjectIds as string[])[0]
    policy(!subjects.has(subjectId)); subjects.add(subjectId)
    if (capability === 'mcp.tools') {
      policy(Array.isArray(b.tools) && b.tools.length > 0 && b.tools.length <= 32)
      for (const tool of b.tools as unknown[]) {
        const t = shape(tool, ['name', 'inputSchema', 'readOnly'], ['outputSchema'])
        policy(identifier(t.name) && t.readOnly === true)
        policy(t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema))
        jsonSchema(t.inputSchema)
        if (t.outputSchema !== undefined) {
          policy(t.outputSchema && typeof t.outputSchema === 'object' && !Array.isArray(t.outputSchema))
          jsonSchema(t.outputSchema)
        }
      }
    } else {
      policy(identifier(b.remoteAgentId))
      const a = capability === 'a2a.agent'
        ? shape(b.approval, ['authorizationVersion', 'tenantId', 'effectiveConfigDigest', 'cardSha256', 'protocolVersion'])
        : shape(b.approval, ['authorizationVersion', 'tenantId', 'effectiveConfigDigest', 'mode', 'allowedTools', 'credentialCapability', 'kbSelectionMode',
          'retrieveKbOnlyWhenMentioned', 'mcpSelectionMode', 'skillsSelectionMode', 'sandboxEnabled', 'memoryEnabled'], ['mcpEnabledServiceIds'])
      policy(identifier(a.authorizationVersion) && identifier(a.tenantId)
        && typeof a.effectiveConfigDigest === 'string' && /^[a-f0-9]{64}$/.test(a.effectiveConfigDigest))
      if (capability === 'weknora.agent') policy(idList(a.allowedTools)
        && (a.mcpEnabledServiceIds === undefined || idList(a.mcpEnabledServiceIds)))
    }
  }
  // All fields above are bounded and closed; BindingResolver additionally owns
  // the protocol approval semantics and duplicate/version validation below.
  return structuredClone(input) as BindingConfig
}

export class IntegrationManagement {
  readonly #db: Pool
  readonly #grants: IntegrationTrustGrant[]
  constructor(db: Pool, grants: IntegrationTrustGrant[]) {
    this.#db = db
    this.#grants = validateIntegrationTrust(grants)
  }

  async #admin(companyId: string, userId: string, db: Queryable = this.#db, lock = false): Promise<void> {
    const result = await db.query(`SELECT cm.user_id FROM company_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.company_id=$1 AND cm.user_id=$2 AND cm.role IN ('owner','admin')
        AND u.deleted_at IS NULL AND u.suspended_at IS NULL ${lock ? 'FOR UPDATE OF cm,u' : ''}`, [companyId, userId])
    if (!result.rowCount) throw new HttpError(403, 'integration_forbidden')
  }

  #resolver(config: BindingConfig, companyId: string): BindingResolver {
    const secrets: Record<string, string> = Object.create(null)
    policy(Buffer.byteLength(JSON.stringify(config)) <= MAX_CONFIG_BYTES && !hasIntegrationCredential(config, this.#grants))
    for (const c of config.connections) {
      const bindings = config.bindings.filter(b => b.connectionId === c.id)
      const grant = this.#grants.find(g => g.companyIds.includes(companyId) && g.backend === c.backend
        && g.secretRef === c.secretRef && g.credentialRevision === c.credentialRevision && g.baseUrls.includes(c.baseUrl)
        && c.knowledgeBaseIds.every(id => g.knowledgeBaseIds.includes(id))
        && bindings.every(b => b.capabilityId === 'mcp.tools' ? b.tools.every(t => g.toolNames.includes(t.name))
          : b.kind === 'agent-service' && g.remoteAgentIds.includes(b.remoteAgentId)
            && (b.capabilityId !== 'weknora.agent' || b.approval?.allowedTools.every(name => g.toolNames.includes(name)))))
      policy(grant)
      policy(!Object.hasOwn(secrets, c.secretRef) || secrets[c.secretRef] === grant.value)
      secrets[c.secretRef] = grant.value
    }
    for (const b of config.bindings) {
      const c = config.connections.find(connection => connection.id === b.connectionId)
      policy(c && c.kind === b.kind && c.backend === b.capabilityId.split('.')[0] && c.version === b.connectionVersion)
    }
    try { return new BindingResolver(config, secrets) }
    catch { throw new HttpError(400, 'integration_invalid_policy') }
  }

  async #current(companyId: string, db: Queryable = this.#db): Promise<ConfigRow | undefined> {
    return (await db.query<ConfigRow>('SELECT revision,config FROM integration_configs WHERE company_id=$1', [companyId])).rows[0]
  }

  /** Read through on every authorization checkpoint; no runtime cache or locks. */
  async resolver(actor: BindingActor, db: Queryable = this.#db): Promise<BindingResolver | undefined> {
    if (!actor.companyId || !actor.subjectId) return undefined
    try {
      const current = await this.#current(actor.companyId, db)
      return current ? this.#resolver(parseConfig(current.config, actor.companyId), actor.companyId) : undefined
    } catch { return undefined }
  }

  async view(companyId: string, userId: string): Promise<IntegrationManagementView> {
    await this.#admin(companyId, userId)
    const [current, members, history, activity] = await Promise.all([
      this.#current(companyId),
      this.#db.query<{ id: string; name: string; executionKind: 'native' | 'external-service'; enabled: boolean }>(
        `SELECT id,name,execution_kind AS "executionKind",execution_enabled AS enabled FROM participants
          WHERE company_id=$1 AND kind='agent' AND departed_at IS NULL ORDER BY name,id`, [companyId]),
      this.#db.query<{ revision: number; action: string; actorId: string; createdAt: Date }>(
        `SELECT revision,action,actor_id AS "actorId",created_at AS "createdAt" FROM integration_revisions
          WHERE company_id=$1 ORDER BY revision DESC LIMIT 100`, [companyId]),
      this.#db.query<{ id: string; subjectId: string; status: string; bindingId: string; bindingVersion: string;
        connectionId: string; connectionVersion: string; createdAt: Date; remoteIds: Record<string, unknown> | null }>(
        `SELECT id,subject_id AS "subjectId",status,snapshot->>'bindingId' AS "bindingId",snapshot->>'bindingVersion' AS "bindingVersion",
          snapshot->>'connectionId' AS "connectionId",snapshot->>'connectionVersion' AS "connectionVersion",
          created_at AS "createdAt",remote_ids AS "remoteIds" FROM external_invocations
          WHERE company_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [companyId]),
    ])
    const targets: IntegrationTarget[] = []
    for (const grant of this.#grants) {
      if (!grant.companyIds.includes(companyId)) continue
      for (const baseUrl of grant.baseUrls) targets.push({ secretRef: grant.secretRef, credentialRevision: grant.credentialRevision,
        backend: grant.backend, baseUrl, knowledgeBaseIds: [...grant.knowledgeBaseIds], remoteAgentIds: [...grant.remoteAgentIds], toolNames: [...grant.toolNames] })
    }
    const invocations = activity.rows.map(row => {
      const remoteIds: Record<string, string> = {}
      for (const key of ['sessionId', 'assistantMessageId', 'userMessageId', 'remoteRequestId', 'contextId', 'taskId', 'messageId']) {
        const value = row.remoteIds?.[key]
        if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value) && !this.#grants.some(g => value.includes(g.value))) remoteIds[key] = value
      }
      return { ...row, createdAt: new Date(row.createdAt).toISOString(), remoteIds: Object.keys(remoteIds).length ? remoteIds : null }
    })
    await this.#admin(companyId, userId)
    const view = { revision: current?.revision ?? 0, config: current?.config ?? structuredClone(EMPTY_CONFIG), targets, members: members.rows,
      history: history.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })), invocations }
    if (hasIntegrationCredential(view, this.#grants)) throw new HttpError(503, 'integration_unavailable')
    return view
  }

  async #mutate<T>(companyId: string, userId: string, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.#db.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['integration-management', companyId])])
      await this.#admin(companyId, userId, tx, true)
      const result = await work(tx)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {})
      throw error
    } finally { tx.release() }
  }

  async #publish(companyId: string, userId: string, expectedRevision: number, input: unknown, action: string, rollbackRevision?: number): Promise<IntegrationManagementView> {
    revisionNumber(expectedRevision)
    await this.#mutate(companyId, userId, async tx => {
      const current = await this.#current(companyId, tx)
      if ((current?.revision ?? 0) !== expectedRevision) throw new HttpError(409, 'integration_stale_revision')
      if (rollbackRevision !== undefined) {
        const history = await tx.query<{ config: BindingConfig }>('SELECT config FROM integration_revisions WHERE company_id=$1 AND revision=$2', [companyId, rollbackRevision])
        if (!history.rows[0]) throw new HttpError(400, 'integration_invalid_revision')
        input = history.rows[0].config
      }
      const config = parseConfig(input, companyId)
      const revision = expectedRevision + 1
      const version = `r${revision}`
      for (const connection of config.connections) connection.version = version
      for (const binding of config.bindings) {
        binding.version = version
        binding.connectionVersion = version
        if (binding.kind === 'agent-service' && binding.approval) binding.approval.authorizationVersion = version
      }
      const resolver = this.#resolver(config, companyId)
      const subjects = [...new Set([...(current?.config.bindings ?? []), ...config.bindings].flatMap(b => b.subjectIds))].sort()
      for (const subjectId of subjects) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([companyId, subjectId])])
      const participants = subjects.length ? (await tx.query<MemberRow>(
        `SELECT id,name,execution_kind,execution_enabled,runtime_assignment_id,execution_binding_id,execution_binding_version,
          execution_config_digest,departed_at FROM participants WHERE company_id=$1 AND kind='agent' AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`,
        [companyId, subjects])).rows : []
      const byId = new Map(participants.map(row => [row.id, row]))
      for (const binding of config.bindings) {
        const row = byId.get(binding.subjectIds[0])
        policy(row && !row.departed_at && row.execution_kind === (binding.kind === 'agent-service' ? 'external-service' : 'native'))
      }
      // ponytail: every workspace publication invalidates all configured subjects;
      // add per-subject revisions only if this conservative ceiling becomes costly.
      for (const row of participants) {
        if (row.execution_kind === 'native') {
          await tx.query('UPDATE participants SET runtime_assignment_id=$3 WHERE company_id=$1 AND id=$2', [companyId, row.id, randomUUID()])
          continue
        }
        const selected = resolver.resolveAgent({ companyId, subjectId: row.id })
        if (selected.ok) {
          const pending = await tx.query(`SELECT 1 FROM external_invocations WHERE company_id=$1 AND subject_id=$2
            AND status IN ('queued','dispatching','running','unknown') UNION ALL
            SELECT 1 FROM external_message_deliveries WHERE company_id=$1 AND member_id=$2
            AND status IN ('queued','running','blocked_unknown') LIMIT 1`, [companyId, row.id])
          if (pending.rowCount) throw new HttpError(409, 'integration_external_work_pending')
        }
        await tx.query(`UPDATE participants SET runtime_assignment_id=$3,execution_enabled=$4,
          execution_binding_id=$5,execution_binding_version=$6,execution_config_digest=$7 WHERE company_id=$1 AND id=$2`,
        [companyId, row.id, randomUUID(), selected.ok, selected.ok ? selected.binding.id : null,
          selected.ok ? selected.binding.version : null, selected.ok ? selected.binding.approval.effectiveConfigDigest : null])
      }
      await tx.query(`INSERT INTO integration_revisions(company_id,revision,config,action,actor_id)
        VALUES($1,$2,$3::jsonb,$4,$5)`, [companyId, revision, JSON.stringify(config), action, userId])
      await tx.query(`INSERT INTO integration_configs(company_id,revision,config) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(company_id) DO UPDATE SET revision=EXCLUDED.revision,config=EXCLUDED.config,updated_at=NOW()`, [companyId, revision, JSON.stringify(config)])
      await tx.query(`INSERT INTO audit_events(user_id,company_id,kind,detail) VALUES($1,$2,'integration_config',$3::jsonb)`,
        [userId, companyId, JSON.stringify({ action, revision, previousRevision: expectedRevision, ...(rollbackRevision === undefined ? {} : { rollbackRevision }) })])
    })
    return this.view(companyId, userId)
  }

  async save(companyId: string, userId: string, expectedRevision: number, config: BindingConfig, action = 'save'): Promise<IntegrationManagementView> {
    policy(action === 'save' || action === 'import')
    return this.#publish(companyId, userId, expectedRevision, config, action)
  }

  async rollback(companyId: string, userId: string, expectedRevision: number, revision: number): Promise<IntegrationManagementView> {
    revisionNumber(revision)
    policy(revision > 0)
    return this.#publish(companyId, userId, expectedRevision, undefined, 'rollback', revision)
  }

  async createMember(companyId: string, userId: string, name: string, requestId: string): Promise<{ id: string }> {
    policy(typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(name)
      && typeof requestId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(requestId))
    policy(!hasIntegrationCredential({ name, requestId }, this.#grants))
    return this.#mutate(companyId, userId, async tx => {
      const tier = await companyTier(companyId, tx)
      try {
        const result = await createAgentRecord({ companyId, tier, maxActiveAgents: TIER_LIMITS[tier].agentsPerCompany,
          name: name.trim(), requestId, executionKind: 'external-service', systemPrompt: '', tools: [] }, tx)
        if (result.created) await tx.query(`INSERT INTO audit_events(user_id,company_id,kind,detail) VALUES($1,$2,'integration_member_created',$3::jsonb)`,
          [userId, companyId, JSON.stringify({ subjectId: result.id, executionKind: 'external-service', enabled: false })])
        return { id: result.id }
      } catch (error) {
        if (error instanceof AgentCreationError) throw new HttpError(error.status, error.status === 403 ? 'integration_member_quota' : 'integration_member_creation_failed')
        throw error
      }
    })
  }

  async test(companyId: string, userId: string, revision: number, bindingId: string): Promise<IntegrationProbeResult> {
    revisionNumber(revision)
    policy(identifier(bindingId))
    await this.#admin(companyId, userId)
    const current = await this.#current(companyId)
    if (!current || current.revision !== revision) throw new HttpError(409, 'integration_stale_revision')
    const config = parseConfig(current.config, companyId)
    const binding: IntegrationBinding | undefined = config.bindings.find(b => b.id === bindingId)
    if (!binding || binding.capabilityId === 'weknora.search' || !binding.enabled
      || !config.connections.some(c => c.id === binding.connectionId && c.enabled)) throw new HttpError(400, 'integration_binding_unavailable')
    const actor = { companyId, subjectId: binding.subjectIds[0] }
    const resolver = this.#resolver(config, companyId)
    let assignment: string | undefined
    const reauthorize = async () => {
      await this.#admin(companyId, userId)
      const check = await this.#db.query<MemberRow & { revision: number }>(
        `SELECT p.id,p.execution_kind,p.execution_enabled,p.runtime_assignment_id,p.execution_binding_id,p.execution_binding_version,
          p.execution_config_digest,c.revision FROM participants p JOIN integration_configs c ON c.company_id=p.company_id
          WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.departed_at IS NULL`, [companyId, actor.subjectId])
      const row = check.rows[0]
      if (!row || row.revision !== revision || !row.execution_enabled || (assignment && row.runtime_assignment_id !== assignment)
        || (binding.kind === 'tool' ? row.execution_kind !== 'native' : row.execution_kind !== 'external-service'
          || row.execution_binding_id !== binding.id || row.execution_binding_version !== binding.version
          || row.execution_config_digest !== binding.approval?.effectiveConfigDigest)) throw new HttpError(409, 'integration_authorization_changed')
      assignment = row.runtime_assignment_id
    }
    await reauthorize()
    const result = await probeIntegration(resolver, actor, reauthorize, binding.capabilityId)
    await reauthorize()
    return result
  }
}

let installed: IntegrationManagement | undefined
export function installIntegrationManagement(service: IntegrationManagement | undefined): void { installed = service }
export function getIntegrationManagement(): IntegrationManagement {
  if (!installed) throw new HttpError(503, 'integration_unavailable')
  return installed
}
