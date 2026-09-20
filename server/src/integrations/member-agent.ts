import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { resolveExecution } from '../agents/execution.js'
import { mentionedAgentIds } from '../agents/scheduler.js'
import { persistReply } from '../message-persistence.js'
import { CH_STATUS } from '../redis.js'
import { enqueueBroadcast, nudgeRealtimeOutbox } from '../realtime-outbox.js'
import type { BindingResolver, ResolvedAgentBinding } from './bindings.js'
import { bindingSnapshot, executeClaim } from './agent-execution.js'
import { InvocationStore, invocationDigest, type Invocation, type InvocationSnapshot } from './invocations.js'
import { presentAnswer, requireAnswer, sourceEvidence } from './agent-evidence.js'

export interface DeliveryStatusView {
  id: string
  memberId: string
  sourceMessageId: string
  status: 'queued' | 'running' | 'blocked_unknown' | 'withheld' | 'completed' | 'failed'
  reason: string | null
  invocationId: string | null
  finalMessageId: string | null
  textOnly: boolean
  expired: boolean
  revision: number
}
interface Delivery {
  id: string; company_id: string; member_id: string; source_message_id: string; conversation_id: string
  source_author_id: string; source_sequence: number; assignment_id: string; context_id: string
  snapshot: InvocationSnapshot | null; input_digest: string; input_text: string | null
  invocation_id: string | null; final_message_id: string | null; status: DeliveryStatusView['status']; reason: string | null
  text_only: boolean; content_expires_at: Date; status_version: number
}
const statusView = (d: Delivery): DeliveryStatusView => ({ id: d.id, memberId: d.member_id, sourceMessageId: d.source_message_id,
  status: d.status, reason: d.reason, invocationId: d.invocation_id, finalMessageId: d.final_message_id,
  textOnly: d.text_only, expired: new Date(d.content_expires_at).getTime() <= Date.now(), revision: d.status_version })

/** HTTP uses this before its conversation lock. Never acquire a newly discovered member after that lock. */
export async function lockMessageParticipants(tx: PoolClient, companyId: string, conversationId: string, authorId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(`SELECT p.id FROM participants p WHERE p.company_id=$1
    AND (p.id=$3 OR (p.execution_kind='external-service' AND EXISTS(
      SELECT 1 FROM conversation_members cm WHERE cm.company_id=$1 AND cm.conversation_id=$2 AND cm.participant_id=p.id)))
    ORDER BY p.id FOR SHARE OF p`, [companyId, conversationId, authorId])
  return rows.rows.map(p => p.id)
}

/** Transactional admission, bounded draining, trusted publication and current-ACL reads. */
export class MemberAgent {
  readonly #db: Pool
  readonly #bindings?: BindingResolver
  readonly #store: InvocationStore
  // ponytail: one in-flight drain per process; use a bounded member pool if throughput requires it.
  #timer?: NodeJS.Timeout
  #draining?: Promise<number>
  #stopping = false
  constructor(db: Pool, bindings?: BindingResolver) { this.#db = db; this.#bindings = bindings; this.#store = new InvocationStore(db) }

  async acceptMessage(tx: PoolClient, messageId: string, lockedParticipantIds: readonly string[]): Promise<DeliveryStatusView[]> {
    const source = (await tx.query<{ id: string; company_id: string; conversation_id: string; author_id: string; sequence: number;
      body: string; attachment: unknown; room_kind: string; external_context_id: string }>(`SELECT m.*,c.kind AS room_kind,c.external_context_id
      FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.company_id=m.company_id
      JOIN participants p ON p.id=m.author_id AND p.company_id=m.company_id AND p.kind='human' AND p.departed_at IS NULL
      JOIN company_members membership ON membership.company_id=m.company_id AND membership.user_id=p.id
      JOIN users u ON u.id=p.id AND u.deleted_at IS NULL
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.company_id=c.company_id AND cm.participant_id=p.id
      WHERE m.id=$1 AND m.kind='text' AND c.kind IN ('direct','group')`, [messageId])).rows[0]
    if (!source) return []
    const members = (await tx.query<{ id: string; runtime_assignment_id: string }>(`SELECT p.id,p.runtime_assignment_id FROM participants p
      JOIN conversation_members cm ON cm.participant_id=p.id AND cm.company_id=p.company_id
      WHERE cm.company_id=$1 AND cm.conversation_id=$2 AND p.kind='agent' AND p.execution_kind='external-service' AND p.departed_at IS NULL
      ORDER BY p.id`, [source.company_id, source.conversation_id])).rows
    const selected = source.room_kind === 'direct' ? members.map(m => m.id) : mentionedAgentIds(source.body, members.map(m => m.id))
    const deliveries: DeliveryStatusView[] = []
    for (const member of members.filter(m => selected.includes(m.id))) {
      if (!lockedParticipantIds.includes(member.id)) throw new Error('conversation_members_changed_retry')
      const actor = { companyId: source.company_id, subjectId: member.id }
      const execution = await resolveExecution(actor, this.#bindings, tx)
      const binding = this.#bindings?.resolve(actor, 'weknora.agent', 'agent-service')
      const reason = !source.body.trim() ? 'text_required' : source.body.length > 8000 ? 'input_too_long'
        : execution.kind !== 'external-service' || !binding?.ok ? 'external_unavailable' : null
      const { rows } = await tx.query<Delivery>(`INSERT INTO external_message_deliveries
        (id,company_id,member_id,source_message_id,conversation_id,source_author_id,source_sequence,assignment_id,context_id,
         snapshot,input_digest,input_text,text_only,status,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT(company_id,member_id,source_message_id) DO NOTHING RETURNING *`,
      [randomUUID(), source.company_id, member.id, source.id, source.conversation_id, source.author_id, source.sequence,
        member.runtime_assignment_id, source.external_context_id, binding?.ok ? bindingSnapshot(binding.binding) : null,
        invocationDigest(source.body), reason ? null : source.body, Boolean(source.attachment), reason ? 'failed' : 'queued', reason])
      if (rows[0]) deliveries.push(statusView(rows[0]))
    }
    return deliveries
  }

  async #locked(tx: PoolClient, candidate: Delivery): Promise<Delivery | null> {
    await tx.query(`SELECT id FROM participants WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE`,
      [candidate.company_id, [candidate.source_author_id, candidate.member_id]])
    await tx.query('SELECT id FROM conversations WHERE company_id=$1 AND id=$2 FOR UPDATE', [candidate.company_id, candidate.conversation_id])
    return (await tx.query<Delivery>('SELECT * FROM external_message_deliveries WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0] ?? null
  }

  async #authorization(tx: PoolClient, d: Delivery): Promise<ResolvedAgentBinding | null> {
    if (new Date(d.content_expires_at).getTime() <= Date.now()) return null
    const source = (await tx.query<{ body: string }>(`SELECT m.body FROM messages m
      JOIN conversations c ON c.id=m.conversation_id AND c.company_id=m.company_id
      JOIN participants a ON a.id=m.author_id AND a.company_id=m.company_id AND a.kind='human' AND a.departed_at IS NULL
      JOIN company_members membership ON membership.company_id=m.company_id AND membership.user_id=a.id
      JOIN users u ON u.id=a.id AND u.deleted_at IS NULL
      JOIN participants p ON p.id=$4 AND p.company_id=m.company_id AND p.kind='agent' AND p.departed_at IS NULL
      WHERE m.id=$1 AND m.company_id=$2 AND m.conversation_id=$3 AND m.author_id=$5 AND m.sequence=$6 AND m.kind='text'
        AND c.kind IN ('direct','group') AND c.external_context_id=$7 AND p.runtime_assignment_id=$8
        AND EXISTS(SELECT 1 FROM conversation_members WHERE company_id=$2 AND conversation_id=$3 AND participant_id=$4)
        AND EXISTS(SELECT 1 FROM conversation_members WHERE company_id=$2 AND conversation_id=$3 AND participant_id=$5)
      FOR SHARE OF m`,
    [d.source_message_id, d.company_id, d.conversation_id, d.member_id, d.source_author_id, d.source_sequence, d.context_id, d.assignment_id])).rows[0]
    if (!source || invocationDigest(source.body) !== d.input_digest) return null
    const actor = { companyId: d.company_id, subjectId: d.member_id }
    const execution = await resolveExecution(actor, this.#bindings, tx)
    const selected = this.#bindings?.resolve(actor, 'weknora.agent', 'agent-service')
    if (execution.kind !== 'external-service' || execution.assignmentId !== d.assignment_id || !selected?.ok
      || !isDeepStrictEqual(bindingSnapshot(selected.binding), d.snapshot)) return null
    return selected.binding
  }

  async #status(tx: PoolClient, d: Delivery, status: Delivery['status'], reason: string | null, force = false): Promise<void> {
    if (!force && d.status === status && d.reason === reason) return
    d.status = status; d.reason = reason
    d.status_version = (await tx.query<{ status_version: number }>(`UPDATE external_message_deliveries
      SET status=$2,reason=$3,status_version=status_version+1,updated_at=NOW() WHERE id=$1 RETURNING status_version`, [d.id, status, reason])).rows[0].status_version
    await enqueueBroadcast(tx, CH_STATUS, { type: 'external.delivery', companyId: d.company_id, conversationId: d.conversation_id, delivery: statusView(d) })
  }

  /** One bounded pass. PostgreSQL coordinates independent instances; Redis is never the work queue. */
  async drain(limit = 16): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_drain_limit')
    if (this.#stopping) return 0
    await this.#store.purgeExpired()
    const candidates = (await this.#db.query<Delivery>(`SELECT * FROM (
      SELECT DISTINCT ON(company_id,member_id) * FROM external_message_deliveries
      WHERE status IN ('queued','running','blocked_unknown') OR (status='failed' AND final_message_id IS NULL)
      ORDER BY company_id,member_id,acceptance_order
    ) pending ORDER BY updated_at,acceptance_order LIMIT $1`, [limit])).rows
    let processed = 0
    for (const candidate of candidates) {
      if (this.#stopping) break
      const actor = { companyId: candidate.company_id, subjectId: candidate.member_id }
      const claimed = await this.#store.withSubjectTransaction(actor, async tx => {
        const d = await this.#locked(tx, candidate)
        if (!d || d.final_message_id || ['completed', 'withheld'].includes(d.status)) return null
        const earlier = await tx.query(`SELECT 1 FROM external_message_deliveries WHERE company_id=$1 AND member_id=$2
          AND acceptance_order<(SELECT acceptance_order FROM external_message_deliveries WHERE id=$3)
          AND (status IN ('queued','running','blocked_unknown') OR (status='failed' AND final_message_id IS NULL)) LIMIT 1`, [d.company_id, d.member_id, d.id])
        if (earlier.rowCount) return null
        await tx.query('UPDATE external_message_deliveries SET updated_at=NOW() WHERE id=$1', [d.id])
        await tx.query(`UPDATE external_invocations SET status='unknown',generation=generation+1,lease_expires_at=NULL,updated_at=NOW()
          WHERE company_id=$1 AND subject_id=$2 AND status IN ('dispatching','running','unknown') AND lease_expires_at<=NOW()`, [d.company_id, d.member_id])
        const existing = d.invocation_id ? (await tx.query<Invocation>('SELECT * FROM external_invocations WHERE id=$1 FOR UPDATE', [d.invocation_id])).rows[0] : null
        if (existing && ['completed', 'failed', 'canceled'].includes(existing.status)) return { d, publish: true as const }
        if (existing && ['dispatching', 'running', 'unknown'].includes(existing.status)) {
          await this.#status(tx, d, existing.status === 'unknown' ? 'blocked_unknown' : 'running', existing.status === 'unknown' ? 'remote_outcome_unknown' : null)
          if (existing.status === 'unknown') {
            const blocked = (await tx.query<Delivery>(`UPDATE external_message_deliveries SET status='blocked_unknown',reason='member_blocked_unknown',status_version=status_version+1,updated_at=NOW()
              WHERE company_id=$1 AND member_id=$2 AND status='queued' AND id<>$3 RETURNING *`, [d.company_id,d.member_id,d.id])).rows
            for (const waiting of blocked) await enqueueBroadcast(tx, CH_STATUS, {
              type: 'external.delivery', companyId: waiting.company_id, conversationId: waiting.conversation_id, delivery: statusView(waiting),
            })
          }
          return null
        }
        if (d.status === 'failed') return { d, publish: true as const }
        const binding = await this.#authorization(tx, d)
        if (!binding || !d.input_text) { await this.#status(tx, d, 'withheld', 'authorization_or_source_changed'); return null }
        const active = await tx.query<{ status: string }>(`SELECT status FROM external_invocations WHERE company_id=$1 AND subject_id=$2
          AND status IN ('dispatching','running','unknown') LIMIT 1`, [d.company_id, d.member_id])
        if (active.rowCount) {
          await this.#status(tx, d, active.rows[0].status === 'unknown' ? 'blocked_unknown' : 'queued', active.rows[0].status === 'unknown' ? 'member_blocked_unknown' : null)
          return null
        }
        const invocation = existing ?? await this.#store.acceptInTransaction(tx, actor, {
          sourceKind: 'chat-message', sourceId: d.source_message_id,
          conversationScope: JSON.stringify([d.conversation_id, d.context_id, d.assignment_id]), query: d.input_text, snapshot: d.snapshot!,
        })
        const owned = await this.#store.claimInTransaction(tx, actor, invocation.id)
        if (!owned) return null
        d.invocation_id = owned.id
        await tx.query('UPDATE external_message_deliveries SET invocation_id=$2 WHERE id=$1', [d.id, owned.id])
        await this.#status(tx, d, 'running', null)
        return { d, publish: false as const, owned, binding }
      })
      nudgeRealtimeOutbox()
      if (!claimed) continue
      if (!claimed.publish) {
        const { d, owned, binding } = claimed
        await executeClaim(this.#store, actor, owned, binding, async () => {
          await this.#store.withSubjectTransaction(actor, async tx => {
            const current = await this.#locked(tx, d)
            if (!current || !await this.#authorization(tx, current)) throw new Error('authorization_changed')
            const owner = await tx.query(`SELECT 1 FROM external_invocations WHERE id=$1 AND generation=$2
              AND status IN ('dispatching','running') AND lease_expires_at>NOW() FOR SHARE`, [owned.id, owned.generation])
            if (!owner.rowCount) throw new Error('owner_lost')
          })
        }, async (result, client, signal) => {
          if (result.status !== 'completed') return result
          try {
            requireAnswer({ status: result.status, result })
            if (!result.evidence.complete || !result.ids) throw new Error('complete_ids_required')
            const evidence = sourceEvidence(await client.history(result.ids, signal), { id: owned.id, remote_ids: result.ids, result }, {
              remoteAgentId: binding.remoteAgentId, knowledgeBaseIds: binding.knowledgeBaseIds, allowedTools: binding.approval.allowedTools,
            })
            return { ...result, validation: { ok: true, evidence } }
          } catch { return { ...result, validation: { ok: false, reason: 'answer_validation_failed' } } }
        })
      }
      await this.publishExternalResult(claimed.d.id)
      processed++
    }
    return processed
  }

  /** Trusted id only; no caller-selected author, room, quote or answer. Never invokes the backend. */
  async publishExternalResult(deliveryId: string): Promise<void> {
    const candidate = (await this.#db.query<Delivery>('SELECT * FROM external_message_deliveries WHERE id=$1', [deliveryId])).rows[0]
    if (!candidate) return
    const tx = await this.#db.connect()
    try {
      await tx.query('BEGIN')
      const d = await this.#locked(tx, candidate)
      if (!d || d.final_message_id || ['completed', 'withheld'].includes(d.status)) { await tx.query('COMMIT'); return }
      const invocation = d.invocation_id ? (await tx.query<Invocation>('SELECT * FROM external_invocations WHERE id=$1 FOR UPDATE', [d.invocation_id])).rows[0] : null
      if (invocation && (invocation.company_id !== d.company_id || invocation.subject_id !== d.member_id
        || invocation.source_kind !== 'chat-message' || invocation.source_id !== d.source_message_id
        || invocation.input_digest !== d.input_digest || !isDeepStrictEqual(invocation.snapshot, d.snapshot))) {
        await this.#status(tx, d, 'withheld', 'invocation_source_mismatch')
        await tx.query('COMMIT'); return
      }
      if (invocation && ['unknown','dispatching','running','queued'].includes(invocation.status)) {
        await this.#status(tx, d, invocation.status === 'unknown' ? 'blocked_unknown' : 'running', invocation.status === 'unknown' ? 'remote_outcome_unknown' : null)
        await tx.query('COMMIT'); return
      }
      if (!await this.#authorization(tx, d) || (invocation && new Date(invocation.content_expires_at).getTime() <= Date.now())) {
        await this.#status(tx, d, 'withheld', 'authorization_source_or_expiry_changed')
        await tx.query('COMMIT'); return
      }
      const validation = invocation?.result?.validation as { ok?: boolean; evidence?: Record<string, unknown> } | undefined
      const presentation = invocation?.status === 'completed' && validation?.ok === true && validation.evidence && typeof invocation.result?.answer === 'string'
        ? presentAnswer(invocation.result.answer, validation.evidence) : undefined
      const success = Boolean(presentation)
      if (!invocation && d.status !== 'failed') { await tx.query('COMMIT'); return }
      const messageId = `m-${randomUUID()}`
      const sequence = (await tx.query<{ seq: number }>(`INSERT INTO conversation_counters(conversation_id,next_sequence) VALUES($1,2)
        ON CONFLICT(conversation_id) DO UPDATE SET next_sequence=conversation_counters.next_sequence+1 RETURNING next_sequence-1 AS seq`, [d.conversation_id])).rows[0].seq
      const source = (await tx.query<{ body: string; name: string }>(`SELECT m.body,p.name FROM messages m JOIN participants p ON p.id=m.author_id AND p.company_id=m.company_id WHERE m.id=$1`, [d.source_message_id])).rows[0]
      await persistReply(tx, d.company_id, {
        id: messageId, conversationId: d.conversation_id, authorId: d.member_id, kind: 'text',
        body: presentation ? presentation.body : `外部回答未能验证或执行失败。调用 ID：${d.invocation_id ?? d.id}。不会自动重试。`,
        sequence, at: new Date().toISOString(), quotedMessageId: d.source_message_id,
        quoted: { id: d.source_message_id, authorId: d.source_author_id, authorName: source.name, kind: 'text', body: source.body.slice(0,240), sequence: d.source_sequence },
        externalResult: { citations: presentation?.citations ?? [], citationStatus: presentation?.citationStatus ?? 'none',
          deliveryId: d.id, invocationId: d.invocation_id ?? '' },
      }, d.id)
      d.final_message_id = messageId
      await tx.query('UPDATE external_message_deliveries SET final_message_id=$2 WHERE id=$1', [d.id, messageId])
      await this.#status(tx, d, success ? 'completed' : 'failed', success ? null : d.reason ?? 'answer_validation_or_execution_failed', true)
      await tx.query('COMMIT')
    } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error } finally { tx.release(); nudgeRealtimeOutbox() }
  }

  async readDelivery(companyId: string, requesterId: string, deliveryId: string): Promise<Record<string, unknown> | null> {
    const candidate = (await this.#db.query<Delivery>('SELECT * FROM external_message_deliveries WHERE company_id=$1 AND id=$2', [companyId, deliveryId])).rows[0]
    if (!candidate) return null
    const tx = await this.#db.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('SELECT id FROM participants WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE', [companyId, [requesterId, candidate.member_id, candidate.source_author_id]])
      const d = await this.#locked(tx, candidate)
      const requester = await tx.query(`SELECT 1 FROM participants p JOIN conversation_members cm ON cm.participant_id=p.id AND cm.company_id=p.company_id
        WHERE p.company_id=$1 AND p.id=$2 AND p.departed_at IS NULL AND cm.conversation_id=$3`, [companyId, requesterId, candidate.conversation_id])
      if (!d || !requester.rowCount) { await tx.query('COMMIT'); return null }
      const view = statusView(d)
      if (view.expired) { await tx.query('COMMIT'); return { ...view, status: 'expired' } }
      if (!await this.#authorization(tx, d)) { await tx.query('COMMIT'); return { ...view, status: 'withheld', reason: 'authorization_or_source_changed' } }
      const invocation = d.invocation_id ? (await tx.query<Invocation>('SELECT * FROM external_invocations WHERE id=$1 AND company_id=$2 AND subject_id=$3 AND content_expires_at>NOW()', [d.invocation_id, companyId, d.member_id])).rows[0] : null
      const validation = invocation?.result?.validation as { ok?: boolean; evidence?: Record<string, unknown> } | undefined
      await tx.query('COMMIT')
      return { ...view, ...(validation?.ok && validation.evidence && typeof invocation?.result?.answer === 'string'
        ? { answer: invocation.result.answer, presentation: presentAnswer(invocation.result.answer, validation.evidence) } : {}) }
    } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error } finally { tx.release() }
  }

  async attachStatuses(companyId: string, conversationId: string, messages: Array<{ id: string; externalDeliveries?: DeliveryStatusView[] }>): Promise<void> {
    if (!messages.length) return
    const deliveries = (await this.#db.query<Delivery>(`SELECT * FROM external_message_deliveries
      WHERE company_id=$1 AND conversation_id=$2 AND source_message_id=ANY($3::text[]) ORDER BY acceptance_order`,
    [companyId, conversationId, messages.map(m => m.id)])).rows
    for (const message of messages) message.externalDeliveries = deliveries.filter(d => d.source_message_id === message.id).map(statusView)
  }

  start(): void {
    if (this.#timer || !this.#bindings) return
    this.#stopping = false
    const tick = () => {
      if (!this.#draining && !this.#stopping) this.#draining = this.drain().catch(() => { console.error('[external-agent] drain failed; durable work retained'); return 0 }).finally(() => { this.#draining = undefined })
    }
    this.#timer = setInterval(tick, 1000); this.#timer.unref(); tick()
  }
  async stop(): Promise<void> {
    this.#stopping = true
    clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#draining) await Promise.race([this.#draining, new Promise<void>(resolve => { const timer = setTimeout(resolve, 185_000); timer.unref() })])
  }
}

let memberAgent = new MemberAgent(pool)
export function getMemberAgent(): MemberAgent { return memberAgent }
/** Startup/test composition only. Stop the previous owner before replacing the immutable snapshot. */
export function installMemberAgent(service: MemberAgent): void { memberAgent = service }
