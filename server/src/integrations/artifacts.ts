import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import type {
  ArtifactActor, ArtifactCitation, ArtifactContent, ArtifactHandoff, ArtifactSummary,
  ArtifactVersion, ArtifactView, CaptureArtifactInput, CreateArtifactHandoffInput,
} from '../../../shared/external-artifacts.js'
import { presentAnswer, type AnswerPresentation } from './agent-evidence.js'
import { invocationDigest, type Invocation } from './invocations.js'

export const ARTIFACT_WORKSPACE_PREFIX = 'external-artifacts/'

export class ArtifactError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ArtifactError' }
}

interface SourceScope {
  company_id: string
  owner_id: string
  producer_id: string
  producer_assignment_id: string
  source_conversation_id: string
  source_context_id: string
}
interface ArtifactRow extends SourceScope {
  id: string
  title: string | null
  input_text: string | null
  input_revision: number
  latest_version: number
  content_expires_at: Date
  created_at: Date
}
interface VersionRow {
  artifact_id: string
  version: number
  input_revision: number
  producer_id: string
  source_delivery_id: string | null
  sha256: string
  created_at: Date
}
interface HandoffRow {
  id: string
  artifact_id: string
  source_version: number
  input_revision: number
  assignee_id: string
  assignment_id: string
  task_id: string
  request_id: string
  request_digest: string
  instructions: string | null
  status: ArtifactHandoff['status']
  output_version: number | null
  review_note: string | null
  created_at: Date
}
interface ParticipantRow {
  id: string
  kind: string
  departed_at: Date | null
  execution_kind: string
  execution_enabled: boolean
  runtime_assignment_id: string
}
interface DeliveryRow {
  id: string
  company_id: string
  member_id: string
  assignment_id: string
  source_author_id: string
  source_message_id: string
  source_sequence: number
  conversation_id: string
  context_id: string
  input_text: string | null
  input_digest: string
  invocation_id: string | null
  final_message_id: string | null
  status: string
  text_only: boolean
  snapshot: Invocation['snapshot'] | null
  content_expires_at: Date
}
interface Snapshot {
  artifactId: string
  version: number
  inputRevision: number
  inputText: string
  producerId: string
  sourceDeliveryId: string | null
  expiresAt: string
  createdAt: string
  body: string
  citations: ArtifactCitation[]
  limitations: string[]
}

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArtifactError(400, 'invalid_artifact_input')
}
function text(value: unknown, name: string, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) {
    throw new ArtifactError(400, `invalid_${name}`)
  }
}
function identifier(value: unknown): asserts value is string {
  text(value, 'identifier', 256)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/.test(value)) throw new ArtifactError(400, 'invalid_identifier')
}
function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647) throw new ArtifactError(400, `invalid_${name}`)
}
function actorInput(actor: ArtifactActor): void {
  object(actor)
  identifier(actor.companyId)
  identifier(actor.subjectId)
}
function versionView(v: VersionRow, root: ArtifactRow): ArtifactVersion {
  return { version: v.version, inputRevision: v.input_revision, producerId: v.producer_id, sourceDeliveryId: v.source_delivery_id,
    sha256: v.sha256, createdAt: new Date(v.created_at).toISOString(), stale: v.input_revision !== root.input_revision }
}
function handoffView(h: HandoffRow, expired = false): ArtifactHandoff {
  return { id: h.id, sourceVersion: h.source_version, assigneeId: h.assignee_id, taskId: h.task_id,
    instructions: expired ? '' : h.instructions ?? '', status: h.status, outputVersion: h.output_version,
    reviewNote: expired ? null : h.review_note, createdAt: new Date(h.created_at).toISOString() }
}
function summary(root: ArtifactRow): ArtifactSummary {
  const expired = new Date(root.content_expires_at).getTime() <= Date.now()
  return { id: root.id, title: expired ? 'Expired artifact' : root.title ?? '', ownerId: root.owner_id,
    sourceConversationId: root.source_conversation_id, inputRevision: root.input_revision,
    inputText: expired ? '' : root.input_text ?? '', latestVersion: root.latest_version,
    expiresAt: new Date(root.content_expires_at).toISOString(), expired }
}
function requireLive(root: ArtifactRow): void {
  if (new Date(root.content_expires_at).getTime() <= Date.now() || root.input_text === null) throw new ArtifactError(410, 'artifact_expired')
}
function requireRevision(root: ArtifactRow, revision: number): void {
  if (revision !== root.input_revision) throw new ArtifactError(409, 'artifact_input_revision_changed')
}

/** Durable fixed versions and explicit grants; no networking, scheduler, or pool creation. */
export class ArtifactService {
  readonly #db: Pool
  constructor(pool: Pool) { this.#db = pool }

  async #transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.#db.connect()
    try {
      await tx.query('BEGIN')
      const result = await work(tx)
      await tx.query('COMMIT')
      return result
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {})
      throw error
    } finally { tx.release() }
  }

  /** Company/account lifecycle locks precede ordered participants, then the room,
   * then artifact/delivery records. No nested pool transaction or subject lock. */
  async #authority(tx: PoolClient, source: SourceScope, extraIds: string[]): Promise<Map<string, ParticipantRow>> {
    const company = await tx.query('SELECT id FROM companies WHERE id=$1 FOR SHARE', [source.company_id])
    const user = await tx.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL FOR SHARE', [source.owner_id])
    const membership = await tx.query('SELECT user_id FROM company_members WHERE company_id=$1 AND user_id=$2 FOR SHARE', [source.company_id, source.owner_id])
    if (!company.rowCount || !user.rowCount || !membership.rowCount) throw new ArtifactError(403, 'artifact_source_access_revoked')
    const participants = (await tx.query<ParticipantRow>(`SELECT id,kind,departed_at,execution_kind,execution_enabled,runtime_assignment_id
      FROM participants WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE`,
    [source.company_id, [source.owner_id, source.producer_id, ...extraIds]])).rows
    const byId = new Map(participants.map(p => [p.id, p]))
    const owner = byId.get(source.owner_id)
    const producer = byId.get(source.producer_id)
    if (!owner || owner.kind !== 'human' || owner.departed_at || !producer || producer.kind !== 'agent' || producer.departed_at
      || producer.execution_kind !== 'external-service' || !producer.execution_enabled || producer.runtime_assignment_id !== source.producer_assignment_id) {
      throw new ArtifactError(403, 'artifact_source_access_revoked')
    }
    const room = await tx.query(`SELECT id FROM conversations WHERE id=$1 AND company_id=$2
      AND external_context_id=$3 AND kind IN ('direct','group') FOR UPDATE`,
    [source.source_conversation_id, source.company_id, source.source_context_id])
    const members = await tx.query<{ participant_id: string }>(`SELECT participant_id FROM conversation_members
      WHERE conversation_id=$1 AND company_id=$2 AND participant_id=ANY($3::text[])`,
    [source.source_conversation_id, source.company_id, [source.owner_id, source.producer_id]])
    if (!room.rowCount || members.rowCount !== 2) throw new ArtifactError(403, 'artifact_source_access_revoked')
    return byId
  }

  #native(participants: Map<string, ParticipantRow>, id: string, assignmentId?: string): ParticipantRow {
    const p = participants.get(id)
    if (!p || p.kind !== 'agent' || p.departed_at || p.execution_kind !== 'native' || !p.execution_enabled
      || (assignmentId !== undefined && p.runtime_assignment_id !== assignmentId)) throw new ArtifactError(403, 'artifact_native_assignment_required')
    return p
  }

  async #withArtifact<T>(actor: ArtifactActor, id: string, options: { owner?: boolean; live?: boolean; extraIds?: string[] },
    work: (tx: PoolClient, root: ArtifactRow, participants: Map<string, ParticipantRow>) => Promise<T>): Promise<T> {
    actorInput(actor); identifier(id)
    return this.#transaction(async tx => {
      const candidate = (await tx.query<ArtifactRow>('SELECT * FROM external_artifacts WHERE id=$1 AND company_id=$2', [id, actor.companyId])).rows[0]
      if (!candidate) throw new ArtifactError(404, 'artifact_not_found')
      if (options.owner && candidate.owner_id !== actor.subjectId) throw new ArtifactError(403, 'artifact_owner_required')
      const participants = await this.#authority(tx, candidate, [actor.subjectId, ...(options.extraIds ?? [])])
      const root = (await tx.query<ArtifactRow>('SELECT * FROM external_artifacts WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, actor.companyId])).rows[0]
      if (!root) throw new ArtifactError(404, 'artifact_not_found')
      if (options.live) requireLive(root)
      const result = await work(tx, root, participants)
      if (options.live) requireLive(root)
      return result
    })
  }

  async #view(tx: PoolClient, root: ArtifactRow): Promise<ArtifactView> {
    const versions = (await tx.query<VersionRow>('SELECT * FROM external_artifact_versions WHERE artifact_id=$1 ORDER BY version', [root.id])).rows
    const handoffs = (await tx.query<HandoffRow>('SELECT * FROM external_artifact_handoffs WHERE artifact_id=$1 ORDER BY created_at,id', [root.id])).rows
    const view = summary(root)
    return { ...view, versions: versions.map(v => versionView(v, root)), handoffs: handoffs.map(h => handoffView(h, view.expired)) }
  }

  async #version(tx: PoolClient, root: ArtifactRow, version: number): Promise<VersionRow> {
    const v = (await tx.query<VersionRow>('SELECT * FROM external_artifact_versions WHERE artifact_id=$1 AND version=$2', [root.id, version])).rows[0]
    if (!v) throw new ArtifactError(404, 'artifact_version_not_found')
    return v
  }

  async #content(tx: PoolClient, root: ArtifactRow, v: VersionRow): Promise<ArtifactContent> {
    requireLive(root)
    const row = (await tx.query<{ body: string }>(`SELECT body FROM agent_workspace WHERE company_id=$1 AND agent_id=$2 AND path=$3`,
      [root.company_id, root.producer_id, `${ARTIFACT_WORKSPACE_PREFIX}${root.id}/${v.version}.json`])).rows[0]
    if (!row) throw new ArtifactError(410, 'artifact_content_unavailable')
    if (createHash('sha256').update(row.body).digest('hex') !== v.sha256) throw new ArtifactError(409, 'artifact_integrity_failed')
    const snapshot = JSON.parse(row.body) as Snapshot
    return { ...versionView(v, root), artifactId: root.id, body: snapshot.body, citations: snapshot.citations,
      limitations: snapshot.limitations, inputText: snapshot.inputText, expiresAt: new Date(root.content_expires_at).toISOString() }
  }

  async #storeVersion(tx: PoolClient, root: ArtifactRow, input: {
    producerId: string; sourceDeliveryId: string | null; body: string; citations: ArtifactCitation[]; limitations: string[]
  }): Promise<ArtifactContent> {
    requireLive(root)
    const version = root.latest_version + 1
    positive(version, 'version')
    const createdAt = new Date().toISOString()
    const snapshot: Snapshot = { artifactId: root.id, version, inputRevision: root.input_revision, inputText: root.input_text!,
      producerId: input.producerId, sourceDeliveryId: input.sourceDeliveryId, expiresAt: new Date(root.content_expires_at).toISOString(),
      createdAt, body: input.body, citations: input.citations, limitations: input.limitations }
    const body = JSON.stringify(snapshot)
    const sha256 = createHash('sha256').update(body).digest('hex')
    await tx.query(`INSERT INTO external_artifact_versions(artifact_id,version,input_revision,producer_id,source_delivery_id,sha256,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [root.id, version, root.input_revision, input.producerId, input.sourceDeliveryId, sha256, createdAt])
    await tx.query(`INSERT INTO agent_workspace(agent_id,path,body,company_id,meta) VALUES($1,$2,$3,$4,$5)`,
      [root.producer_id, `${ARTIFACT_WORKSPACE_PREFIX}${root.id}/${version}.json`, body, root.company_id, { kind: 'external-artifact', artifactId: root.id, version }])
    await tx.query('UPDATE external_artifacts SET latest_version=$2 WHERE id=$1', [root.id, version])
    root.latest_version = version
    return { artifactId: root.id, version, inputRevision: root.input_revision, producerId: input.producerId,
      sourceDeliveryId: input.sourceDeliveryId, sha256, createdAt, stale: false, body: input.body, citations: input.citations,
      limitations: input.limitations, inputText: snapshot.inputText, expiresAt: snapshot.expiresAt }
  }

  async #handoff(tx: PoolClient, root: ArtifactRow, id: string): Promise<HandoffRow> {
    const handoff = (await tx.query<HandoffRow>('SELECT * FROM external_artifact_handoffs WHERE id=$1 AND artifact_id=$2 FOR UPDATE', [id, root.id])).rows[0]
    if (!handoff) throw new ArtifactError(404, 'artifact_handoff_not_found')
    return handoff
  }

  #usable(root: ArtifactRow, h: HandoffRow, participants: Map<string, ParticipantRow>): void {
    requireLive(root)
    this.#native(participants, h.assignee_id, h.assignment_id)
    if (h.input_revision !== root.input_revision || h.status === 'cancelled' || h.status === 'stale') throw new ArtifactError(409, 'artifact_handoff_revoked')
  }

  async list(actor: ArtifactActor): Promise<ArtifactView[]> {
    actorInput(actor)
    const human = await this.#db.query(`SELECT p.id FROM participants p
      JOIN users u ON u.id=p.id AND u.deleted_at IS NULL AND u.suspended_at IS NULL
      JOIN companies c ON c.id=p.company_id
      JOIN company_members cm ON cm.company_id=p.company_id AND cm.user_id=p.id
      WHERE p.company_id=$1 AND p.id=$2 AND p.kind='human' AND p.departed_at IS NULL`, [actor.companyId, actor.subjectId])
    if (!human.rowCount) throw new ArtifactError(403, 'artifact_owner_required')
    // Never return another human's metadata, or the room/input to a delegated agent.
    const roots = (await this.#db.query<{ id: string }>('SELECT id FROM external_artifacts WHERE company_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id', [actor.companyId, actor.subjectId])).rows
    const results: ArtifactView[] = []
    for (const root of roots) {
      try {
        const item = await this.#withArtifact(actor, root.id, { owner: true }, (tx, row) => this.#view(tx, row))
        results.push(item)
      } catch (error) {
        if (!(error instanceof ArtifactError) || ![403, 404].includes(error.status)) throw error
      }
    }
    return results
  }

  async read(actor: ArtifactActor, id: string): Promise<ArtifactView> {
    return this.#withArtifact(actor, id, { owner: true }, (tx, root) => this.#view(tx, root))
  }

  async capture(actor: ArtifactActor, input: CaptureArtifactInput): Promise<ArtifactView> {
    actorInput(actor); object(input); identifier(input.deliveryId)
    if (input.title !== undefined) text(input.title, 'title', 200)
    if (input.artifactId !== undefined) { identifier(input.artifactId); positive(input.expectedRevision, 'expected_revision') }
    else if (input.expectedRevision !== undefined) throw new ArtifactError(400, 'artifact_id_required')
    return this.#transaction(async tx => {
      const candidate = (await tx.query<DeliveryRow>('SELECT * FROM external_message_deliveries WHERE id=$1 AND company_id=$2', [input.deliveryId, actor.companyId])).rows[0]
      if (!candidate) throw new ArtifactError(404, 'artifact_delivery_not_found')
      if (candidate.source_author_id !== actor.subjectId) throw new ArtifactError(403, 'artifact_owner_required')
      const scope: SourceScope = { company_id: candidate.company_id, owner_id: candidate.source_author_id, producer_id: candidate.member_id,
        producer_assignment_id: candidate.assignment_id, source_conversation_id: candidate.conversation_id, source_context_id: candidate.context_id }
      await this.#authority(tx, scope, [])
      const d = (await tx.query<DeliveryRow>('SELECT * FROM external_message_deliveries WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0]
      if (!d || d.status !== 'completed' || !d.invocation_id || !d.final_message_id) throw new ArtifactError(409, 'artifact_completed_delivery_required')
      if (!d.input_text || new Date(d.content_expires_at).getTime() <= Date.now()) throw new ArtifactError(410, 'artifact_source_expired')
      const invocation = (await tx.query<Invocation>('SELECT * FROM external_invocations WHERE id=$1 FOR SHARE', [d.invocation_id])).rows[0]
      if (!invocation || new Date(invocation.content_expires_at).getTime() <= Date.now()) throw new ArtifactError(410, 'artifact_source_expired')
      const validation = invocation.result?.validation
      if (invocation.status !== 'completed' || invocation.company_id !== d.company_id || invocation.subject_id !== d.member_id
        || invocation.source_kind !== 'chat-message' || invocation.source_id !== d.source_message_id || invocation.input_text !== d.input_text
        || invocation.input_digest !== d.input_digest || !isDeepStrictEqual(invocation.snapshot, d.snapshot)
        || invocation.conversation_scope !== JSON.stringify([d.conversation_id, d.context_id, d.assignment_id])
        || !validation || typeof validation !== 'object' || Array.isArray(validation)) throw new ArtifactError(409, 'artifact_source_mismatch')
      const checked = validation as Record<string, unknown>
      if (checked.ok !== true || !checked.evidence || typeof checked.evidence !== 'object' || Array.isArray(checked.evidence)
        || typeof invocation.result?.answer !== 'string' || !invocation.result.answer.trim()) throw new ArtifactError(409, 'artifact_validated_answer_required')
      const evidence = checked.evidence as Record<string, unknown>
      // Previously persisted WeKnora receipts carry the two source IDs separately.
      const sourceIdsMatch = evidence.remoteIds !== undefined
        ? isDeepStrictEqual(evidence.remoteIds, invocation.remote_ids)
        : typeof evidence.sessionId === 'string' && typeof evidence.assistantMessageId === 'string'
          && evidence.sessionId === invocation.remote_ids?.sessionId && evidence.assistantMessageId === invocation.remote_ids?.assistantMessageId
      if (evidence.invocationId !== invocation.id || evidence.remoteAnswerMatches !== true || !sourceIdsMatch) {
        throw new ArtifactError(409, 'artifact_source_mismatch')
      }
      const source = (await tx.query<{ body: string }>(`SELECT body FROM messages WHERE id=$1 AND company_id=$2 AND conversation_id=$3
        AND author_id=$4 AND sequence=$5 AND kind='text' FOR SHARE`, [d.source_message_id, d.company_id, d.conversation_id, actor.subjectId, d.source_sequence])).rows[0]
      const final = (await tx.query<{ body: string; external_result: Record<string, unknown> | null }>(`SELECT body,external_result FROM messages
        WHERE id=$1 AND company_id=$2 AND conversation_id=$3 AND author_id=$4 AND external_delivery_id=$5 AND kind='text' FOR SHARE`,
      [d.final_message_id, d.company_id, d.conversation_id, d.member_id, d.id])).rows[0]
      let presentation: AnswerPresentation
      try { presentation = presentAnswer(invocation.result.answer, evidence) }
      catch { throw new ArtifactError(409, 'artifact_invalid_source_evidence') }
      // JSONB omits absent optional fields; compare the published JSON shape.
      for (const citation of presentation.citations) {
        if (citation.chunkIndex === undefined) delete citation.chunkIndex
      }
      if (!source || source.body !== d.input_text || invocationDigest(source.body) !== d.input_digest || !final
        || final.body !== presentation.body || !final.external_result || final.external_result.deliveryId !== d.id || final.external_result.invocationId !== invocation.id
        || final.external_result.citationStatus !== presentation.citationStatus
        || !isDeepStrictEqual(final.external_result.citations, presentation.citations)) throw new ArtifactError(409, 'artifact_source_mismatch')
      const existing = (await tx.query<VersionRow>('SELECT * FROM external_artifact_versions WHERE source_delivery_id=$1', [d.id])).rows[0]
      if (existing) {
        if (input.artifactId !== undefined && input.artifactId !== existing.artifact_id) throw new ArtifactError(409, 'artifact_capture_target_conflict')
        const root = (await tx.query<ArtifactRow>('SELECT * FROM external_artifacts WHERE id=$1 AND company_id=$2 FOR UPDATE', [existing.artifact_id, actor.companyId])).rows[0]
        if (!root || root.owner_id !== actor.subjectId) throw new ArtifactError(403, 'artifact_owner_required')
        requireLive(root)
        if (input.expectedRevision !== undefined && input.expectedRevision !== existing.input_revision) throw new ArtifactError(409, 'artifact_capture_revision_conflict')
        if (input.title !== undefined && input.title !== root.title) throw new ArtifactError(409, 'artifact_capture_title_conflict')
        return this.#view(tx, root)
      }
      const expiresAt = new Date(Math.min(new Date(d.content_expires_at).getTime(), new Date(invocation.content_expires_at).getTime()))
      let root: ArtifactRow
      if (input.artifactId !== undefined) {
        const prior = (await tx.query<ArtifactRow>('SELECT * FROM external_artifacts WHERE id=$1 AND company_id=$2', [input.artifactId, actor.companyId])).rows[0]
        if (!prior) throw new ArtifactError(404, 'artifact_not_found')
        if (prior.owner_id !== actor.subjectId || prior.producer_id !== d.member_id || prior.source_conversation_id !== d.conversation_id
          || prior.producer_assignment_id !== d.assignment_id || prior.source_context_id !== d.context_id) throw new ArtifactError(409, 'artifact_capture_source_conflict')
        root = (await tx.query<ArtifactRow>('SELECT * FROM external_artifacts WHERE id=$1 FOR UPDATE', [prior.id])).rows[0]
        requireLive(root); requireRevision(root, input.expectedRevision!)
        if (root.input_text !== d.input_text) throw new ArtifactError(409, 'artifact_capture_input_conflict')
        if (input.title !== undefined && input.title !== root.title) throw new ArtifactError(409, 'artifact_capture_title_conflict')
        // A later answer never extends the original artifact's retention window.
        if (expiresAt.getTime() < new Date(root.content_expires_at).getTime()) {
          await tx.query('UPDATE external_artifacts SET content_expires_at=$2 WHERE id=$1', [root.id, expiresAt])
          root.content_expires_at = expiresAt
        }
      } else {
        root = (await tx.query<ArtifactRow>(`INSERT INTO external_artifacts
          (id,company_id,owner_id,producer_id,producer_assignment_id,source_conversation_id,source_context_id,title,input_text,content_expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(), d.company_id, actor.subjectId, d.member_id, d.assignment_id,
        d.conversation_id, d.context_id, input.title ?? d.input_text.slice(0, 120), d.input_text, expiresAt])).rows[0]
      }
      const limitations = ['Untrusted external Markdown; citations establish same-turn search provenance, not verified conclusions.',
        'Original document verification remains human-owned; no source-room, knowledge-base or credential access is granted.']
      if (d.text_only) limitations.push('Only the original message text was submitted; attachments were not processed.')
      if (presentation.citationStatus !== 'verified') limitations.push('Some or all source citations are unavailable or unverified.')
      await this.#storeVersion(tx, root, { producerId: d.member_id, sourceDeliveryId: d.id, body: presentation.body, citations: presentation.citations, limitations })
      requireLive(root)
      return this.#view(tx, root)
    })
  }

  async readVersion(actor: ArtifactActor, id: string, version: number): Promise<ArtifactContent> {
    positive(version, 'version')
    return this.#withArtifact(actor, id, { live: true }, async (tx, root, participants) => {
      if (actor.subjectId !== root.owner_id) {
        const native = this.#native(participants, actor.subjectId)
        const grants = (await tx.query<HandoffRow>(`SELECT * FROM external_artifact_handoffs WHERE artifact_id=$1 AND assignee_id=$2
          AND assignment_id=$3 AND input_revision=$4 AND status IN ('assigned','submitted','accepted','rejected')
          AND (source_version=$5 OR output_version=$5)`, [root.id, actor.subjectId, native.runtime_assignment_id, root.input_revision, version])).rows
        if (!grants.length) throw new ArtifactError(403, 'artifact_version_not_granted')
      }
      return this.#content(tx, root, await this.#version(tx, root, version))
    })
  }

  async revise(actor: ArtifactActor, id: string, input: { expectedRevision: number; inputText: string }): Promise<ArtifactView> {
    object(input); positive(input.expectedRevision, 'expected_revision'); text(input.inputText, 'input_text', 8000)
    return this.#withArtifact(actor, id, { owner: true, live: true }, async (tx, root) => {
      requireRevision(root, input.expectedRevision)
      positive(root.input_revision + 1, 'input_revision')
      const stale = (await tx.query<HandoffRow>(`UPDATE external_artifact_handoffs SET status='stale'
        WHERE artifact_id=$1 AND status IN ('assigned','submitted') RETURNING *`, [root.id])).rows
      await tx.query(`UPDATE agent_tasks SET status='dropped',updated_at=NOW() WHERE company_id=$1 AND id=ANY($2::text[])`, [root.company_id, stale.map(h => h.task_id)])
      root.input_text = input.inputText; root.input_revision++
      await tx.query('UPDATE external_artifacts SET input_text=$2,input_revision=$3 WHERE id=$1', [root.id, root.input_text, root.input_revision])
      return this.#view(tx, root)
    })
  }

  async handoff(actor: ArtifactActor, id: string, input: CreateArtifactHandoffInput): Promise<{ handoff: ArtifactHandoff; created: boolean }> {
    object(input); positive(input.version, 'version'); positive(input.expectedRevision, 'expected_revision')
    identifier(input.assigneeId); identifier(input.requestId); text(input.instructions, 'instructions', 8000)
    return this.#withArtifact(actor, id, { owner: true, live: true, extraIds: [input.assigneeId] }, async (tx, root, participants) => {
      requireRevision(root, input.expectedRevision)
      const assignee = this.#native(participants, input.assigneeId)
      const digest = invocationDigest([input.version, input.expectedRevision, input.assigneeId, input.instructions])
      const existing = (await tx.query<HandoffRow>('SELECT * FROM external_artifact_handoffs WHERE artifact_id=$1 AND request_id=$2', [root.id, input.requestId])).rows[0]
      if (existing) {
        if (existing.request_digest !== digest) throw new ArtifactError(409, 'artifact_handoff_request_conflict')
        if (existing.assignment_id !== assignee.runtime_assignment_id) throw new ArtifactError(409, 'artifact_handoff_assignment_changed')
        return { handoff: handoffView(existing), created: false }
      }
      const version = await this.#version(tx, root, input.version)
      if (version.input_revision !== root.input_revision || version.source_delivery_id === null) throw new ArtifactError(409, 'artifact_current_external_version_required')
      await this.#content(tx, root, version)
      const count = (await tx.query<{ count: string }>('SELECT count(*) FROM external_artifact_handoffs WHERE artifact_id=$1', [root.id])).rows[0]
      if (Number(count.count) >= 3) throw new ArtifactError(409, 'artifact_handoff_limit')
      const handoffId = randomUUID()
      const taskId = `task-${randomUUID()}`
      await tx.query(`INSERT INTO agent_tasks(id,agent_id,company_id,title,ref) VALUES($1,$2,$3,$4,$5)`,
        [taskId, assignee.id, root.company_id, 'External artifact report', { kind: 'external-artifact', artifactId: root.id, handoffId, sourceVersion: input.version }])
      const h = (await tx.query<HandoffRow>(`INSERT INTO external_artifact_handoffs
        (id,artifact_id,source_version,input_revision,assignee_id,assignment_id,task_id,request_id,request_digest,instructions,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'assigned') RETURNING *`,
      [handoffId, root.id, input.version, root.input_revision, assignee.id, assignee.runtime_assignment_id, taskId, input.requestId, digest, input.instructions])).rows[0]
      return { handoff: handoffView(h), created: true }
    })
  }

  async inbox(actor: ArtifactActor): Promise<Array<{ artifactId: string; handoff: ArtifactHandoff }>> {
    actorInput(actor)
    const participant = (await this.#db.query<ParticipantRow>(`SELECT id,kind,departed_at,execution_kind,execution_enabled,runtime_assignment_id
      FROM participants WHERE company_id=$1 AND id=$2`, [actor.companyId, actor.subjectId])).rows[0]
    this.#native(new Map(participant ? [[participant.id, participant]] : []), actor.subjectId)
    const candidates = (await this.#db.query<{ id: string; artifact_id: string }>(`SELECT h.id,h.artifact_id FROM external_artifact_handoffs h
      JOIN external_artifacts a ON a.id=h.artifact_id WHERE a.company_id=$1 AND h.assignee_id=$2
      AND h.status IN ('assigned','submitted','accepted','rejected') ORDER BY h.created_at,h.id`, [actor.companyId, actor.subjectId])).rows
    const inbox: Array<{ artifactId: string; handoff: ArtifactHandoff }> = []
    for (const candidate of candidates) {
      try {
        const item = await this.#withArtifact(actor, candidate.artifact_id, { live: true }, async (tx, root, participants) => {
          const h = await this.#handoff(tx, root, candidate.id)
          this.#usable(root, h, participants)
          return { artifactId: root.id, handoff: handoffView(h) }
        })
        inbox.push(item)
      } catch (error) {
        if (!(error instanceof ArtifactError) || ![403, 404, 409, 410].includes(error.status)) throw error
      }
    }
    return inbox
  }

  async submit(actor: ArtifactActor, handoffId: string, body: string): Promise<ArtifactContent> {
    actorInput(actor); identifier(handoffId); text(body, 'body', 1_000_000)
    const candidate = (await this.#db.query<{ artifact_id: string }>(`SELECT h.artifact_id FROM external_artifact_handoffs h
      JOIN external_artifacts a ON a.id=h.artifact_id WHERE h.id=$1 AND a.company_id=$2 AND h.assignee_id=$3`, [handoffId, actor.companyId, actor.subjectId])).rows[0]
    if (!candidate) throw new ArtifactError(404, 'artifact_handoff_not_found')
    return this.#withArtifact(actor, candidate.artifact_id, { live: true }, async (tx, root, participants) => {
      const h = await this.#handoff(tx, root, handoffId)
      if (h.assignee_id !== actor.subjectId) throw new ArtifactError(403, 'artifact_assignee_required')
      this.#usable(root, h, participants)
      const source = await this.#version(tx, root, h.source_version)
      if (source.input_revision !== root.input_revision) throw new ArtifactError(409, 'artifact_input_revision_changed')
      if (h.output_version !== null) {
        const existing = await this.#content(tx, root, await this.#version(tx, root, h.output_version))
        if (existing.body !== body) throw new ArtifactError(409, 'artifact_submission_conflict')
        return existing
      }
      if (h.status !== 'assigned') throw new ArtifactError(409, 'artifact_handoff_not_assigned')
      const original = await this.#content(tx, root, source)
      const output = await this.#storeVersion(tx, root, { producerId: actor.subjectId, sourceDeliveryId: null, body,
        citations: original.citations, limitations: [...original.limitations, 'Native report draft awaiting explicit human review; inherited citations do not verify new conclusions.'] })
      await tx.query(`UPDATE external_artifact_handoffs SET status='submitted',output_version=$2 WHERE id=$1`, [h.id, output.version])
      // Task completion describes draft production, never the human review decision.
      await tx.query(`UPDATE agent_tasks SET status='done',updated_at=NOW() WHERE id=$1 AND company_id=$2 AND agent_id=$3`, [h.task_id, root.company_id, actor.subjectId])
      return output
    })
  }

  async review(actor: ArtifactActor, id: string, handoffId: string,
    input: { outputVersion: number; decision: 'accepted' | 'rejected'; note: string }): Promise<ArtifactView> {
    actorInput(actor); identifier(id); identifier(handoffId); object(input); positive(input.outputVersion, 'output_version'); text(input.note, 'review_note', 8000, true)
    if (input.decision !== 'accepted' && input.decision !== 'rejected') throw new ArtifactError(400, 'invalid_review_decision')
    const candidate = (await this.#db.query<{ assignee_id: string }>(`SELECT h.assignee_id FROM external_artifact_handoffs h
      JOIN external_artifacts a ON a.id=h.artifact_id WHERE h.id=$1 AND h.artifact_id=$2 AND a.company_id=$3 AND a.owner_id=$4`,
    [handoffId, id, actor.companyId, actor.subjectId])).rows[0]
    if (!candidate) throw new ArtifactError(404, 'artifact_handoff_not_found')
    return this.#withArtifact(actor, id, { owner: true, live: true, extraIds: [candidate.assignee_id] }, async (tx, root, participants) => {
      const h = await this.#handoff(tx, root, handoffId)
      this.#usable(root, h, participants)
      if (h.output_version !== input.outputVersion) throw new ArtifactError(409, 'artifact_review_output_conflict')
      const output = await this.#version(tx, root, input.outputVersion)
      if (output.input_revision !== root.input_revision) throw new ArtifactError(409, 'artifact_input_revision_changed')
      await this.#content(tx, root, output)
      if (h.status === input.decision && h.review_note === input.note) return this.#view(tx, root)
      if (h.status !== 'submitted') throw new ArtifactError(409, 'artifact_review_conflict')
      await tx.query('UPDATE external_artifact_handoffs SET status=$2,review_note=$3 WHERE id=$1', [h.id, input.decision, input.note])
      return this.#view(tx, root)
    })
  }

  async cancel(actor: ArtifactActor, id: string, handoffId: string): Promise<ArtifactView> {
    identifier(handoffId)
    return this.#withArtifact(actor, id, { owner: true, live: true }, async (tx, root) => {
      const h = await this.#handoff(tx, root, handoffId)
      if (h.status === 'cancelled') return this.#view(tx, root)
      if (h.status !== 'assigned' && h.status !== 'submitted') throw new ArtifactError(409, 'artifact_handoff_terminal')
      await tx.query(`UPDATE external_artifact_handoffs SET status='cancelled' WHERE id=$1`, [h.id])
      await tx.query(`UPDATE agent_tasks SET status='dropped',updated_at=NOW() WHERE id=$1 AND company_id=$2`, [h.task_id, root.company_id])
      return this.#view(tx, root)
    })
  }

  async purgeExpired(): Promise<void> {
    await this.#transaction(async tx => {
      const expired = (await tx.query<ArtifactRow>(`SELECT * FROM external_artifacts WHERE content_expires_at<=clock_timestamp()
        AND (input_text IS NOT NULL OR title IS NOT NULL) ORDER BY content_expires_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED`)).rows
      if (!expired.length) return
      const ids = expired.map(root => root.id)
      await tx.query(`DELETE FROM agent_workspace w USING external_artifacts a,external_artifact_versions v
        WHERE a.id=ANY($1::text[]) AND v.artifact_id=a.id AND w.company_id=a.company_id AND w.agent_id=a.producer_id
        AND w.path=$2||a.id||'/'||v.version::text||'.json'`, [ids, ARTIFACT_WORKSPACE_PREFIX])
      const revoked = (await tx.query<HandoffRow>(`UPDATE external_artifact_handoffs
        SET instructions=NULL,review_note=NULL,status=CASE WHEN status IN ('assigned','submitted') THEN 'stale' ELSE status END
        WHERE artifact_id=ANY($1::text[]) RETURNING *`, [ids])).rows
      await tx.query(`UPDATE agent_tasks SET status='dropped',updated_at=NOW() WHERE id=ANY($1::text[])
        AND status IN ('open','doing')`, [revoked.map(h => h.task_id)])
      await tx.query('UPDATE external_artifacts SET title=NULL,input_text=NULL WHERE id=ANY($1::text[])', [ids])
    })
  }
}
