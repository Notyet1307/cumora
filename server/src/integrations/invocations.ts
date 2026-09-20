import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { BindingActor } from './bindings.js'

export type InvocationStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'
export interface InvocationSnapshot {
  bindingId: string
  bindingVersion: string
  connectionId: string
  connectionVersion: string
  authorizationVersion: string
  remoteAgentId: string
  tenantId: string
  knowledgeBaseIds: string[]
  effectiveConfigDigest: string
}
export interface Invocation {
  id: string
  company_id: string
  subject_id: string
  source_kind: 'operator-probe' | 'chat-message'
  source_id: string
  request_digest: string
  input_digest: string
  conversation_scope: string
  input_text: string | null
  snapshot: InvocationSnapshot
  session_scope: string
  status: InvocationStatus
  generation: number
  remote_ids: Record<string, string> | null
  result: Record<string, unknown> | null
  cancel_observation: Record<string, unknown> | null
  observation_attempted: boolean
  content_expires_at: Date
}
export interface InvocationInput {
  sourceKind?: Invocation['source_kind']
  sourceId: string
  conversationScope: string
  query: string
  snapshot: InvocationSnapshot
}
export function invocationDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function checkActor(actor: BindingActor): void {
  if (!actor.companyId || !actor.subjectId) throw new Error('invalid_actor')
}

function safeSnapshot(value: InvocationSnapshot): InvocationSnapshot {
  const { bindingId, bindingVersion, connectionId, connectionVersion, authorizationVersion, remoteAgentId, tenantId, knowledgeBaseIds, effectiveConfigDigest } = value
  if (![bindingId, bindingVersion, connectionId, connectionVersion, authorizationVersion, remoteAgentId, tenantId, effectiveConfigDigest].every(v => typeof v === 'string' && v.trim() && v.length <= 256)
    || !Array.isArray(knowledgeBaseIds) || !knowledgeBaseIds.length || !knowledgeBaseIds.every(v => typeof v === 'string' && v.trim())) throw new Error('invalid_snapshot')
  return { bindingId, bindingVersion, connectionId, connectionVersion, authorizationVersion, remoteAgentId, tenantId, knowledgeBaseIds: [...knowledgeBaseIds], effectiveConfigDigest }
}

/** No pool creation, worker loop, or networking on import. The operator supplies the database. */
export class InvocationStore {
  readonly #db: Pool
  constructor(db: Pool) { this.#db = db }

  async withSubjectTransaction<T>(actor: BindingActor, work: (tx: PoolClient) => Promise<T>): Promise<T> {
    checkActor(actor)
    const tx = await this.#db.connect()
    try {
      await tx.query('BEGIN')
      // Serialize only this subject's short DB transitions, never its network wait.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([actor.companyId, actor.subjectId])])
      const value = await work(tx)
      await tx.query('COMMIT')
      return value
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally { tx.release() }
  }

  async accept(actor: BindingActor, input: InvocationInput): Promise<Invocation> {
    return this.withSubjectTransaction(actor, tx => this.acceptInTransaction(tx, actor, input))
  }

  /** Caller already holds the subject lock; never open a second connection. */
  async acceptInTransaction(tx: PoolClient, actor: BindingActor, input: InvocationInput): Promise<Invocation> {
    checkActor(actor)
    if (![input.sourceId, input.conversationScope].every(s => typeof s === 'string' && s.trim() && s.length <= (input.sourceKind === 'chat-message' ? 512 : 256))
      || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 8000) throw new Error('invalid_probe')
    const sourceKind = input.sourceKind ?? 'operator-probe'
    if (!['operator-probe', 'chat-message'].includes(sourceKind)) throw new Error('invalid_source_kind')
    const s = safeSnapshot(input.snapshot)
    const requestDigest = invocationDigest([input.query, input.conversationScope, s.bindingId, s.connectionId, s.remoteAgentId, s.tenantId, [...s.knowledgeBaseIds].sort()])
    const scope = [actor.companyId, actor.subjectId, s.bindingId, s.bindingVersion, s.connectionId, s.connectionVersion, input.conversationScope, s.authorizationVersion]
    if (sourceKind === 'chat-message') scope.push(sourceKind)
    const { rows } = await tx.query<Invocation>(`INSERT INTO external_invocations
      (id,company_id,subject_id,source_kind,source_id,request_digest,input_text,snapshot,session_scope,input_digest,conversation_scope)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (company_id,subject_id,source_kind,source_id) DO NOTHING RETURNING *`,
    [randomUUID(), actor.companyId, actor.subjectId, sourceKind, input.sourceId, requestDigest, input.query, s, invocationDigest(scope), invocationDigest(input.query), input.conversationScope])
    const record = rows[0] ?? (await tx.query<Invocation>(`SELECT * FROM external_invocations
      WHERE company_id=$1 AND subject_id=$2 AND source_kind=$3 AND source_id=$4`, [actor.companyId, actor.subjectId, sourceKind, input.sourceId])).rows[0]
    if (!record || record.request_digest !== requestDigest) throw new Error('source_conflict')
    return record
  }

  async get(actor: BindingActor, id: string): Promise<Invocation | null> {
    checkActor(actor)
    const row = (await this.#db.query<Invocation & { content_available: boolean }>('SELECT *,content_expires_at>NOW() AS content_available FROM external_invocations WHERE company_id=$1 AND subject_id=$2 AND id=$3', [actor.companyId, actor.subjectId, id])).rows[0]
    if (!row) return null
    if (!row.content_available) { row.input_text = null; row.result = null }
    return row
  }

  async expireLeases(actor: BindingActor): Promise<void> {
    checkActor(actor)
    await this.#db.query(`UPDATE external_invocations SET status='unknown', generation=generation+1, lease_expires_at=NULL, updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND status IN ('dispatching','running','unknown') AND lease_expires_at <= NOW()`, [actor.companyId, actor.subjectId])
  }

  async claim(actor: BindingActor, id: string, observation = false): Promise<Invocation | null> {
    return this.withSubjectTransaction(actor, tx => this.claimInTransaction(tx, actor, id, observation))
  }

  async claimInTransaction(tx: PoolClient, actor: BindingActor, id: string, observation = false): Promise<Invocation | null> {
    await tx.query(`UPDATE external_invocations SET status='unknown',generation=generation+1,lease_expires_at=NULL,updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND status IN ('dispatching','running','unknown') AND lease_expires_at <= NOW()`, [actor.companyId, actor.subjectId])
    const { rows } = await tx.query<Invocation>(`UPDATE external_invocations i
      SET status=CASE WHEN $4 THEN 'unknown' ELSE 'dispatching' END,generation=generation+1,
          lease_expires_at=NOW()+INTERVAL '240 seconds',observation_attempted=observation_attempted OR $4,updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND id=$3 AND content_expires_at>NOW()
        AND (($4 AND status='unknown' AND NOT observation_attempted AND lease_expires_at IS NULL AND remote_ids->>'assistantMessageId' IS NOT NULL)
          OR (NOT $4 AND status='queued'))
        AND NOT EXISTS (SELECT 1 FROM external_invocations other WHERE other.company_id=i.company_id AND other.subject_id=i.subject_id
          AND other.id<>i.id AND other.status IN ('dispatching','running','unknown')) RETURNING *`, [actor.companyId, actor.subjectId, id, observation])
    return rows[0] ?? null
  }

  async #owned(actor: BindingActor, id: string, generation: number, assignments: string, values: unknown[]): Promise<void> {
    checkActor(actor)
    const result = await this.#db.query(`UPDATE external_invocations SET ${assignments},updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND id=$3 AND generation=$4
        AND status IN ('dispatching','running','unknown') AND lease_expires_at>NOW()`, [actor.companyId, actor.subjectId, id, generation, ...values])
    if (result.rowCount !== 1) throw new Error('owner_lost')
  }

  async session(actor: BindingActor, invocation: Invocation): Promise<string | null> {
    checkActor(actor)
    return (await this.#db.query<{ remote_session_id: string }>('SELECT remote_session_id FROM external_sessions WHERE scope_key=$1 AND company_id=$2 AND subject_id=$3 AND content_expires_at>NOW()', [invocation.session_scope, actor.companyId, actor.subjectId])).rows[0]?.remote_session_id ?? null
  }

  async saveSession(actor: BindingActor, invocation: Invocation, sessionId: string): Promise<void> {
    await this.withSubjectTransaction(actor, async tx => {
      const owned = await tx.query(`UPDATE external_invocations SET remote_ids=$5,updated_at=NOW()
        WHERE company_id=$1 AND subject_id=$2 AND id=$3 AND generation=$4 AND status='dispatching' AND lease_expires_at>NOW() RETURNING id`,
      [actor.companyId, actor.subjectId, invocation.id, invocation.generation, { sessionId }])
      if (owned.rowCount !== 1) throw new Error('owner_lost')
      await tx.query(`INSERT INTO external_sessions(scope_key,company_id,subject_id,scope,remote_session_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(scope_key) DO UPDATE
        SET remote_session_id=EXCLUDED.remote_session_id,created_at=NOW(),content_expires_at=NOW()+INTERVAL '7 days'
        WHERE external_sessions.content_expires_at<=NOW()`, [invocation.session_scope, actor.companyId, actor.subjectId, { ...invocation.snapshot, conversationScope: invocation.conversation_scope }, sessionId])
      const stored = await tx.query<{ remote_session_id: string }>('SELECT remote_session_id FROM external_sessions WHERE scope_key=$1', [invocation.session_scope])
      if (stored.rows[0]?.remote_session_id !== sessionId) throw new Error('session_conflict')
    })
  }

  async saveIds(actor: BindingActor, id: string, generation: number, ids: Record<string, string>): Promise<void> {
    const current = await this.get(actor, id)
    if (!current || Object.entries(current.remote_ids ?? {}).some(([key, value]) => ids[key] !== value)) throw new Error('remote_id_drift')
    await this.#owned(actor, id, generation, "remote_ids=$5,status=CASE WHEN status='unknown' THEN status ELSE 'running' END", [ids])
  }

  async saveResult(actor: BindingActor, id: string, generation: number, result: Record<string, unknown>): Promise<void> {
    if (!['completed', 'failed', 'unknown'].includes(String(result.status))) throw new Error('invalid_terminal')
    await this.#owned(actor, id, generation, `status=$5,result=CASE WHEN content_expires_at>NOW() THEN $6::jsonb ELSE NULL END,lease_expires_at=NULL,
      cancel_observation=CASE WHEN $6::jsonb->'evidence'->>'stop'='true' THEN COALESCE(cancel_observation,'{}'::jsonb)||'{"eventObserved":true}'::jsonb ELSE cancel_observation END`, [result.status, result])
  }

  async markUnknown(actor: BindingActor, id: string, generation: number): Promise<void> {
    await this.#owned(actor, id, generation, "status='unknown',lease_expires_at=NULL", [])
  }

  async cancelQueued(actor: BindingActor, id: string): Promise<boolean> {
    checkActor(actor)
    return (await this.#db.query(`UPDATE external_invocations SET status='canceled',generation=generation+1,updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND id=$3 AND status='queued'`, [actor.companyId, actor.subjectId, id])).rowCount === 1
  }

  async requestStop(actor: BindingActor, id: string): Promise<boolean> {
    checkActor(actor)
    return (await this.#db.query(`UPDATE external_invocations SET cancel_observation=COALESCE(cancel_observation,'{}'::jsonb)||'{"requested":true}'::jsonb,updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND id=$3 AND status IN ('running','unknown')
        AND remote_ids->>'assistantMessageId' IS NOT NULL AND cancel_observation->>'requested' IS DISTINCT FROM 'true'`, [actor.companyId, actor.subjectId, id])).rowCount === 1
  }

  async recordStop(actor: BindingActor, id: string, observation: Record<string, unknown>): Promise<void> {
    checkActor(actor)
    // Stop observation cannot release the actor lock or overwrite a committed complete.
    await this.#db.query(`UPDATE external_invocations SET cancel_observation=COALESCE(cancel_observation,'{}'::jsonb)||$4::jsonb,updated_at=NOW()
      WHERE company_id=$1 AND subject_id=$2 AND id=$3`, [actor.companyId, actor.subjectId, id, observation])
  }

  async purgeExpired(batchSize = 1000): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 10000) throw new Error('invalid_retention_batch')
    const result = await this.#db.query(`WITH expired AS (
      SELECT id FROM external_invocations WHERE content_expires_at<=NOW() AND (input_text IS NOT NULL OR result IS NOT NULL)
      ORDER BY content_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE external_invocations i SET input_text=NULL,result=NULL FROM expired WHERE i.id=expired.id`, [batchSize])
    await this.#db.query(`WITH expired AS (
      SELECT id FROM external_message_deliveries WHERE content_expires_at<=NOW() AND input_text IS NOT NULL
      ORDER BY content_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE external_message_deliveries d SET input_text=NULL FROM expired WHERE d.id=expired.id`, [batchSize])
    return result.rowCount ?? 0
  }
}
