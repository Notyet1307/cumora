import type { Pool, PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import type { BindingActor, BindingResolver, ResolvedExternalAgentBinding } from '../integrations/bindings.js'

export interface ExecutionRow {
  company_id: string
  runtime_assignment_id: string
  execution_kind: 'native' | 'external-service'
  execution_enabled: boolean
  execution_binding_id: string | null
  execution_binding_version: string | null
  execution_config_digest: string | null
}

/** Missing fields are not legacy native defaults: schema migration owns defaults. */
export function isNativeExecution(row: Pick<ExecutionRow, 'execution_kind' | 'execution_enabled'>): boolean {
  return row.execution_kind === 'native' && row.execution_enabled === true
}

export type ExecutionResolution =
  | { kind: 'native'; assignmentId: string }
  | { kind: 'external-service'; assignmentId: string; bindingId: string; bindingVersion: string; configDigest: string }
  | { kind: 'denied'; code: 'invalid_actor' | 'unavailable' | 'disabled' | 'binding_denied' | 'assignment_changed' }

function matchesBinding(row: ExecutionRow, binding: ResolvedExternalAgentBinding): boolean {
  return row.execution_binding_id === binding.id && row.execution_binding_version === binding.version
    && row.execution_config_digest === binding.approval.effectiveConfigDigest
}

/** Trusted actor only. No resource secrets, host inference, network or native fallback. */
export async function resolveExecution(
  actor: BindingActor, bindings?: BindingResolver, db: Pick<Pool, 'query'> = pool,
): Promise<ExecutionResolution> {
  if (!actor.companyId || !actor.subjectId) return { kind: 'denied', code: 'invalid_actor' }
  try {
    const { rows } = await db.query<ExecutionRow>(
      `SELECT company_id,runtime_assignment_id,execution_kind,execution_enabled,
              execution_binding_id,execution_binding_version,execution_config_digest
         FROM participants WHERE id=$1 AND company_id=$2 AND kind='agent' AND departed_at IS NULL`,
      [actor.subjectId, actor.companyId],
    )
    const row = rows[0]
    if (!row || !row.runtime_assignment_id) return { kind: 'denied', code: 'unavailable' }
    if (!row.execution_enabled) return { kind: 'denied', code: 'disabled' }
    if (isNativeExecution(row)) return { kind: 'native', assignmentId: row.runtime_assignment_id }
    if (row.execution_kind !== 'external-service' || !bindings) return { kind: 'denied', code: 'unavailable' }
    const resolved = bindings.resolveAgent(actor)
    if (!resolved.ok) return { kind: 'denied', code: 'binding_denied' }
    if (!matchesBinding(row, resolved.binding)) return { kind: 'denied', code: 'assignment_changed' }
    return { kind: 'external-service', assignmentId: row.runtime_assignment_id,
      bindingId: resolved.binding.id, bindingVersion: resolved.binding.version,
      configDigest: resolved.binding.approval.effectiveConfigDigest }
  } catch {
    return { kind: 'denied', code: 'unavailable' }
  }
}

/** Operator-owned internal mutation; never exposed as a public runtime action. */
export async function configureExternalExecution(
  actor: BindingActor,
  input: { assignmentId: string; enabled: boolean },
  bindings?: BindingResolver,
  db: Pick<Pool, 'connect'> = pool,
): Promise<string> {
  if (!actor.companyId || !actor.subjectId || !input.assignmentId || typeof input.enabled !== 'boolean') throw new Error('invalid_execution_assignment')
  const tx: PoolClient = await db.connect()
  try {
    await tx.query('BEGIN')
    // Same subject transition lock as InvocationStore; never hold it across network I/O.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([actor.companyId, actor.subjectId])])
    const { rows } = await tx.query<ExecutionRow>(
      `SELECT company_id,runtime_assignment_id,execution_kind,execution_enabled,
              execution_binding_id,execution_binding_version,execution_config_digest
         FROM participants WHERE id=$1 AND company_id=$2 AND kind='agent' AND departed_at IS NULL FOR UPDATE`,
      [actor.subjectId, actor.companyId],
    )
    const row = rows[0]
    if (!row || row.execution_kind !== 'external-service' || row.runtime_assignment_id !== input.assignmentId) throw new Error('execution_assignment_changed')
    let binding: ResolvedExternalAgentBinding | undefined
    if (input.enabled) {
      const active = await tx.query(`SELECT 1 FROM external_invocations WHERE company_id=$1 AND subject_id=$2
        AND status IN ('queued','dispatching','running','unknown') LIMIT 1`, [actor.companyId, actor.subjectId])
      if (active.rowCount) throw new Error('external_invocation_pending')
      const deliveries = await tx.query(`SELECT 1 FROM external_message_deliveries WHERE company_id=$1 AND member_id=$2
        AND status IN ('queued','running','blocked_unknown') LIMIT 1`, [actor.companyId, actor.subjectId])
      if (deliveries.rowCount) throw new Error('external_delivery_pending')
      const selected = bindings?.resolveAgent(actor)
      if (!selected?.ok) throw new Error('external_binding_unavailable')
      binding = selected.binding
      if (row.execution_enabled && !matchesBinding(row, binding)) throw new Error('disable_before_rebinding')
    }
    const updated = await tx.query<{ runtime_assignment_id: string }>(
      `UPDATE participants SET execution_enabled=$3,
         execution_binding_id=CASE WHEN $3 THEN $4 ELSE execution_binding_id END,
         execution_binding_version=CASE WHEN $3 THEN $5 ELSE execution_binding_version END,
         execution_config_digest=CASE WHEN $3 THEN $6 ELSE execution_config_digest END
       WHERE id=$1 AND company_id=$2 RETURNING runtime_assignment_id`,
      [actor.subjectId, actor.companyId, input.enabled, binding?.id ?? null, binding?.version ?? null, binding?.approval.effectiveConfigDigest ?? null],
    )
    await tx.query('COMMIT')
    return updated.rows[0].runtime_assignment_id
  } catch (error) {
    await tx.query('ROLLBACK')
    throw error
  } finally { tx.release() }
}
