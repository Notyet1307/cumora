import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import type { BindingConfig } from '../src/integrations/bindings.js'
import { requireAnswer, sourceEvidence, verifyRouteAEvidence } from '../src/integrations/agent-evidence.js'

// Operator-only acceptance runner. Protocol evidence is pinned to WeKnora
// 1edcd54b43606d9079bb36650efe3f68707a79ea, not its moving development HEAD.
const ORIGIN = 'http://127.0.0.1:8180/api/v1'
const SECRET_REF = 'operator:WEKNORA_AGENT_SCOPED_KEY'
const MAX_JSON = 8 * 1024 * 1024
const CONFIG_FIELDS = `agent_mode agent_type system_prompt system_prompt_id context_template context_template_id model_id rerank_model_id temperature max_completion_tokens thinking citation_enabled max_iterations llm_call_timeout allowed_tools mcp_selection_mode mcp_services mcp_auth_wait_timeout skills_selection_mode selected_skills sandbox_config_id kb_selection_mode knowledge_bases retrieve_kb_only_when_mentioned retain_retrieval_history image_upload_enabled vlm_model_id audio_upload_enabled asr_model_id image_storage_provider supported_file_types chat_parser_engine_rules attachment_image_understanding attachment_ocr_max_pages attachment_parse_wait_timeout_sec data_analysis_enabled faq_priority_enabled faq_direct_answer_threshold faq_score_boost web_search_enabled web_search_max_results web_search_provider_id web_fetch_enabled web_fetch_top_n multi_turn_enabled history_turns memory_enabled embedding_top_k keyword_threshold vector_threshold rerank_top_k rerank_threshold enable_query_expansion enable_rewrite rewrite_prompt_system rewrite_prompt_user query_understand_model_id fallback_strategy fallback_response fallback_prompt intent_prompts question_suggestions`.split(' ')

type JsonObject = Record<string, unknown>
interface Manifest {
  runId: string
  actor: { companyId: string; subjectId: string }
  sourceId: string
  conversationScope: string
  query: string
  bindingConfig: BindingConfig
  remoteEvidence: {
    agent: { id: string; config: JsonObject }
    credential: { id: string | number; tenant_id: string | number; full_access: boolean; knowledge_base_ids: string[]; capabilities: string[] }
    mcp: { enabled_service_ids: string[] }
  }
  allowedKnowledgeIds: string[]
  retentionDays: 7
}

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
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(identifier)
}
function sameSet(a: unknown, b: readonly string[]): boolean {
  return strings(a) && isDeepStrictEqual([...new Set(a)].sort(), [...new Set(b)].sort())
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
function privateFile(path: string, maxBytes = MAX_JSON): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    requireValue(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= maxBytes, 'private_file_required')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}
function persist(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600)
  try { writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
}
function configSnapshot(value: unknown): JsonObject {
  const config = object(value)
  requireValue(Object.keys(config).every(key => CONFIG_FIELDS.includes(key)), 'unrecognized_agent_config')
  return config
}


async function main(): Promise<void> {
  process.umask(0o077)
  requireValue(process.argv.length === 4, 'usage_manifest_migrate_run_get_purge')
  const command = process.argv[3]
  requireValue(['migrate', 'run', 'get', 'purge'].includes(command), 'invalid_command')
  const manifestPath = resolve(process.argv[2])
  const directory = dirname(manifestPath)
  const dirStat = lstatSync(directory)
  requireValue(dirStat.isDirectory() && !dirStat.isSymbolicLink() && dirStat.uid === process.getuid?.() && (dirStat.mode & 0o777) === 0o700, 'private_directory_required')
  const manifest = JSON.parse(privateFile(manifestPath, 1024 * 1024)) as Manifest
  requireValue(identifier(manifest.runId) && identifier(manifest.actor?.companyId) && identifier(manifest.actor?.subjectId), 'invalid_actor_or_run')
  requireValue(identifier(manifest.sourceId) && identifier(manifest.conversationScope), 'invalid_source_scope')
  requireValue(typeof manifest.query === 'string' && manifest.query.trim() && manifest.query.length <= 8000 && manifest.retentionDays === 7, 'invalid_query_retention')
  requireValue(strings(manifest.allowedKnowledgeIds) && manifest.allowedKnowledgeIds.length > 0, 'knowledge_allowlist_required')
  const databaseUrl = process.env.DATABASE_URL
  const key = process.env.WEKNORA_AGENT_SCOPED_KEY
  requireValue(databaseUrl && key && key.trim().length >= 16, 'explicit_database_and_scoped_key_required')
  const database = new URL(databaseUrl)
  requireValue(['postgres:', 'postgresql:'].includes(database.protocol) && ['127.0.0.1', '[::1]'].includes(database.hostname)
    && database.pathname === '/cumora_a12_live' && database.username === 'cumora_a12' && !database.search && !database.hash, 'isolated_database_required')
  const secrets = [key, databaseUrl, decodeURIComponent(database.password)].filter(Boolean)
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
      if (value instanceof Date) return value.toISOString()
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [String(redact(name)), redact(item)]))
    }
    return value
  }
  requireValue(isDeepStrictEqual(redact(manifest), manifest), 'secret_in_manifest')
  const config = manifest.bindingConfig
  requireValue(config?.connections?.length === 1 && config.bindings?.length === 1, 'single_binding_required')
  const connection = config.connections[0]
  const binding = config.bindings[0]
  requireValue(connection.baseUrl === ORIGIN && connection.secretRef === SECRET_REF && connection.kind === 'agent-service', 'fixed_connection_required')
  requireValue(binding.kind === 'agent-service' && binding.approval && sameSet(binding.companyIds, [manifest.actor.companyId]) && sameSet(binding.subjectIds, [manifest.actor.subjectId]), 'isolated_binding_required')
  const approval = binding.approval
  const evidence = manifest.remoteEvidence
  requireValue(evidence?.agent?.id === binding.remoteAgentId && (identifier(evidence.credential?.id) || (Number.isSafeInteger(evidence.credential?.id) && Number(evidence.credential.id) > 0)), 'agent_credential_evidence_required')
  requireValue(hash(evidence) === approval.effectiveConfigDigest, 'approval_digest_mismatch')
  requireValue(evidence.credential.full_access === false && String(evidence.credential.tenant_id) === approval.tenantId
    && sameSet(evidence.credential.capabilities, ['chat']) && sameSet(evidence.credential.knowledge_base_ids, connection.knowledgeBaseIds), 'scoped_credential_required')
  requireValue(Array.isArray(evidence.mcp?.enabled_service_ids) && evidence.mcp.enabled_service_ids.length === 0, 'enabled_mcp_not_allowed')
  const expectedConfig = configSnapshot(evidence.agent.config)
  requireValue(expectedConfig.agent_mode === approval.mode && sameSet(expectedConfig.allowed_tools, approval.allowedTools)
    && expectedConfig.kb_selection_mode === 'selected' && sameSet(expectedConfig.knowledge_bases, connection.knowledgeBaseIds)
    && expectedConfig.retrieve_kb_only_when_mentioned === false && (expectedConfig.skills_selection_mode === 'none' || expectedConfig.skills_selection_mode === '')
    && expectedConfig.memory_enabled === false && !expectedConfig.sandbox_config_id && expectedConfig.web_search_enabled === false
    && !expectedConfig.web_fetch_enabled && !expectedConfig.data_analysis_enabled, 'unsafe_agent_snapshot')
  // The deployed agent service maps an empty raw MCP mode to all. Keep raw evidence intact.
  requireValue((expectedConfig.mcp_selection_mode === '' ? 'all' : expectedConfig.mcp_selection_mode) === approval.mcpSelectionMode, 'mcp_mode_mismatch')

  // Nothing above imports env.ts, dotenv, pool.ts, or native agent modules.
  // Dynamic imports are required here: static pool/migrator imports read dotenv before these guards.
  for (const name of Object.keys(process.env)) if (name.startsWith('PG') || name.startsWith('DOTENV_CONFIG_')) delete process.env[name]
  process.env.DOTENV_CONFIG_PATH = '/dev/null'
  process.env.DOTENV_CONFIG_QUIET = 'true'
  process.env.OPENAI_API_KEY = 'disabled-native-engine-not-a-secret'
  process.env.NODE_ENV = 'development'
  const { BindingResolver } = await import('../src/integrations/bindings.js')
  const resolver = new BindingResolver(config, { [SECRET_REF]: key })
  requireValue(resolver.resolve(manifest.actor, 'weknora.agent', 'agent-service').ok, 'binding_rejected')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network_not_permitted') }
  const { pool } = await import('../src/db/pool.js')
  // The product pool logs raw pg errors by default; this isolated process never does.
  pool.removeAllListeners('error')
  pool.on('error', () => { console.error('isolated_database_idle_error'); process.exitCode = 1 })
  let ledgerFd: number | undefined
  const startedAt = new Date().toISOString()
  const ledgerPath = join(directory, `${manifest.runId}.attempt.jsonl`)
  const manifestDigest = hash(manifest)
  let postCount = 0
  let stage = 'database_preflight'
  const networkController = new AbortController()
  const journal = (event: JsonObject) => {
    requireValue(ledgerFd !== undefined, 'missing_attempt_ledger')
    writeSync(ledgerFd, JSON.stringify(redact({ at: new Date().toISOString(), ...event })) + '\n')
    fsyncSync(ledgerFd)
  }
  const report = (suffix: string, data: unknown) => persist(join(directory, `${manifest.runId}.${suffix}.json`), redact(data))
  try {
    const identity = (await pool.query<{ database: string; user: string }>('SELECT current_database() AS database, current_user AS user')).rows[0]
    requireValue(identity?.database === 'cumora_a12_live' && identity.user === 'cumora_a12', 'database_identity_mismatch')
    if (command === 'migrate') {
      const { ensureSchema } = await import('../src/db/migrate.js')
      await ensureSchema()
    }
    const history = (await pool.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows
    const { validateMigrationHistory, MAX_SUPPORTED_SCHEMA_VERSION } = await import('../src/db/migrations/manifest.js')
    requireValue(validateMigrationHistory(history).currentVersion === MAX_SUPPORTED_SCHEMA_VERSION, 'current_schema_required')
    if (command === 'migrate') {
      report(`migrate-${randomUUID()}`, { startedAt, finishedAt: new Date().toISOString(), identity, history })
      console.log(`migrate: schema ${MAX_SUPPORTED_SCHEMA_VERSION} verified`)
      return
    }
    const { InvocationStore } = await import('../src/integrations/invocations.js')
    const { OperatorAgent } = await import('../src/integrations/operator-agent.js')
    const store = new InvocationStore(pool)
    const operator = new OperatorAgent(resolver, store)
    if (command === 'purge') {
      const row = (await pool.query<{ id: string; expired: boolean }>(
        "SELECT id,content_expires_at<=NOW() AS expired FROM external_invocations WHERE company_id=$1 AND subject_id=$2 AND source_kind='operator-probe' AND source_id=$3",
        [manifest.actor.companyId, manifest.actor.subjectId, manifest.sourceId],
      )).rows[0]
      const purged = await store.purgeExpired()
      const clearedFiles: string[] = []
      if (row?.expired) {
        const contentFiles = readdirSync(directory).filter(name => name === `${manifest.runId}.invocation.json`
          || name === `${manifest.runId}.sources.json` || (name.startsWith(`${manifest.runId}.get-`) && name.endsWith('.json')))
        for (const path of [...contentFiles.map(name => join(directory, name)), join(directory, 'source-baseline.json'), manifestPath]) {
          if (!existsSync(path)) continue
          privateFile(path, 32 * 1024 * 1024)
          unlinkSync(path)
          clearedFiles.push(path)
        }
      }
      report(`purge-${randomUUID()}`, { startedAt, finishedAt: new Date().toISOString(), purged, invocationId: row?.id, clearedFiles, postCount: 0 })
      console.log(`purge: ${purged} expired content records cleared`)
      return
    }
    if (command === 'get') {
      const firstLine = privateFile(ledgerPath).split('\n')[0]
      const attempt = object(JSON.parse(firstLine))
      requireValue(attempt.manifestDigest === manifestDigest && attempt.sourceId === manifest.sourceId, 'attempt_manifest_mismatch')
      const rows = (await pool.query<{ id: string }>("SELECT id FROM external_invocations WHERE company_id=$1 AND subject_id=$2 AND source_kind='operator-probe' AND source_id=$3", [manifest.actor.companyId, manifest.actor.subjectId, manifest.sourceId])).rows
      requireValue(rows.length === 1, 'invocation_not_found_no_resubmit')
      const invocation = await operator.get(manifest.actor, rows[0].id)
      let originalResultMatch: boolean | null = null
      const originalPath = join(directory, `${manifest.runId}.invocation.json`)
      if (existsSync(originalPath) && invocation.content_expires_at.getTime() > Date.now()) {
        const original = object(JSON.parse(privateFile(originalPath, 32 * 1024 * 1024)))
        const current = object(redact(invocation))
        originalResultMatch = ['id', 'status', 'source_id', 'snapshot', 'remote_ids', 'result'].every(field => isDeepStrictEqual(original[field], current[field]))
        requireValue(originalResultMatch, 'independent_get_result_mismatch')
      }
      report(`get-${randomUUID()}`, { startedAt, finishedAt: new Date().toISOString(), postCount: 0, originalResultMatch, invocation })
      requireAnswer(invocation)
      verifyRouteAEvidence(invocation, JSON.parse(privateFile(join(directory, `${manifest.runId}.sources.json`))))
      console.log(`get: ${invocation.status}; no remote requests`)
      return
    }

    // A durable, exclusive attempt is consumed even if a later preflight fails.
    // Never remove this ledger to retry an unknown or interrupted dispatch.
    ledgerFd = openSync(ledgerPath, 'wx', 0o600)
    journal({ event: 'attempt', runId: manifest.runId, sourceId: manifest.sourceId, manifestDigest, startedAt, postCount: 0 })
    const directoryFd = openSync(directory, 'r')
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    const existing = await pool.query('SELECT id FROM external_invocations WHERE company_id=$1 AND subject_id=$2 AND source_id=$3', [manifest.actor.companyId, manifest.actor.subjectId, manifest.sourceId])
    requireValue(existing.rowCount === 0, 'source_already_present_use_get')
    const deadline = AbortSignal.timeout(210_000)
    let sessionId: string | undefined
    let sessionPosts = 0
    let chatPosts = 0
    let configChecks = 0
    let messageReads = 0
    let configVerified = false
    const agentPath = `/api/v1/agents/${binding.remoteAgentId}`
    const boundedJson = async (response: Response): Promise<JsonObject> => {
      requireValue(response.ok && response.body, 'remote_json_unavailable')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          requireValue(size <= MAX_JSON, 'response_size_limit')
          chunks.push(next.value)
        }
        return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    globalThis.fetch = async (input, init) => {
      requireValue(typeof input === 'string' || input instanceof URL, 'request_object_not_permitted')
      const url = new URL(String(input))
      const method = (init?.method ?? 'GET').toUpperCase()
      requireValue(url.origin === 'http://127.0.0.1:8180' && !url.username && !url.password && !url.hash, 'remote_origin_denied')
      if (method === 'POST' && url.pathname === '/api/v1/sessions' && !url.search) {
        requireValue(configVerified && sessionPosts++ === 0 && chatPosts === 0, 'session_post_denied')
      } else if (method === 'POST' && sessionId && url.pathname === `/api/v1/agent-chat/${sessionId}` && !url.search) {
        requireValue(configVerified && sessionPosts === 1 && chatPosts++ === 0, 'chat_post_denied')
      } else if (method === 'GET' && url.pathname === agentPath && !url.search) {
        requireValue(configChecks++ < 2, 'agent_get_limit')
      } else if (method === 'GET' && sessionId && url.pathname === `/api/v1/messages/${sessionId}/load` && url.search === '?limit=2') {
        requireValue(chatPosts === 1 && messageReads++ === 0, 'message_get_limit')
      } else throw new Error('remote_path_denied')
      deadline.throwIfAborted()
      if (method === 'POST') postCount++
      journal({ event: 'request_started', method, path: url.pathname, status: null, postCount })
      const signal = AbortSignal.any([networkController.signal, deadline, AbortSignal.timeout(180_000), ...(init?.signal ? [init.signal] : [])])
      let response: Response
      try {
        response = await originalFetch(url, { ...init, method, redirect: 'error', signal })
      } catch {
        journal({ event: 'request_unconfirmed', method, path: url.pathname, status: null, postCount })
        throw new Error('remote_request_unconfirmed_no_retry')
      }
      journal({ event: 'response_headers', method, path: url.pathname, status: response.status, postCount })
      // Bound all bodies, including preflight/history JSON; never log headers or bytes.
      let bytes = 0
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          requireValue(bytes <= MAX_JSON, 'response_size_limit')
          controller.enqueue(chunk)
        },
        flush() { journal({ event: 'response_complete', method, path: url.pathname, status: response.status, postCount }) },
      }), { signal })
      const bounded = new Response(body ?? null, { status: response.status, headers: response.headers })
      if (method === 'POST' && url.pathname === '/api/v1/sessions' && response.ok) {
        const value = await boundedJson(bounded)
        const candidate = object(value.data).id
        requireValue(identifier(candidate) && !candidate.includes(key), 'invalid_session_id')
        sessionId = candidate
        journal({ event: 'session_bound', sessionId, postCount })
        return new Response(JSON.stringify(value), { status: response.status, headers: response.headers })
      }
      return bounded
    }
    const readRemote = async (path: string) => boundedJson(await fetch(ORIGIN + path, { headers: { 'X-API-Key': key, Accept: 'application/json' } }))
    const verifyAgent = async () => {
      const response = await readRemote(`/agents/${binding.remoteAgentId}`)
      const agent = object(response.data)
      requireValue(response.success === true && agent.id === binding.remoteAgentId && String(agent.tenant_id) === approval.tenantId, 'remote_agent_mismatch')
      const remoteConfig = object(agent.config)
      requireValue(!remoteConfig.sandbox_config_id && remoteConfig.memory_enabled === false && remoteConfig.web_search_enabled === false
        && !remoteConfig.web_fetch_enabled && !remoteConfig.data_analysis_enabled, 'unsafe_remote_agent')
      const observed = Object.fromEntries(Object.keys(expectedConfig).filter(field => Object.hasOwn(remoteConfig, field)).map(field => [field, remoteConfig[field]]))
      requireValue(isDeepStrictEqual(observed, expectedConfig), 'remote_agent_config_drift')
      configVerified = true
      journal({ event: 'agent_verified', configDigest: hash(observed), rawMcpSelectionMode: observed.mcp_selection_mode, rawSkillsSelectionMode: observed.skills_selection_mode, postCount })
    }
    stage = 'agent_preflight'
    await verifyAgent()
    journal({ event: 'submit_entered', postCount })
    stage = 'operator_submit'
    const invocation = await operator.submit(manifest.actor, { sourceId: manifest.sourceId, conversationScope: manifest.conversationScope, query: manifest.query })
    journal({ event: 'submit_returned', invocationId: invocation.id, status: invocation.status, postCount })
    stage = 'local_get_comparison'
    const retrieved = await operator.get(manifest.actor, invocation.id)
    requireValue(isDeepStrictEqual(retrieved, invocation), 'get_result_mismatch')
    report('invocation', invocation)
    if (invocation.status === 'completed') {
      requireValue(invocation.remote_ids?.sessionId === sessionId && identifier(invocation.remote_ids?.assistantMessageId), 'remote_result_ids_mismatch')
      stage = 'postflight_agent_check'
      await verifyAgent()
      stage = 'scoped_source_evidence'
      const messages = await readRemote(`/messages/${sessionId}/load?limit=2`)
      const evidence = sourceEvidence(messages, invocation, {
        remoteAgentId: manifest.remoteEvidence.agent.id,
        knowledgeBaseIds: manifest.bindingConfig.connections[0].knowledgeBaseIds,
        allowedKnowledgeIds: manifest.allowedKnowledgeIds,
      })
      report('sources', evidence)
      verifyRouteAEvidence(invocation, evidence)
    }
    stage = 'answer_acceptance'
    requireAnswer(invocation)
    journal({ event: 'finished', status: invocation.status, finishedAt: new Date().toISOString(), postCount })
    console.log(`run: completed; ${postCount} POSTs; invocation and scoped source evidence saved`)
  } catch {
    if (ledgerFd !== undefined) journal({ event: 'stopped_no_retry', stage, finishedAt: new Date().toISOString(), postCount })
    throw new Error('controlled_operation_failed_inspect_private_evidence_no_retry')
  } finally {
    // Cancel/finish network consumption before closing its journal.
    networkController.abort()
    globalThis.fetch = originalFetch
    await pool.end()
    if (ledgerFd !== undefined) closeSync(ledgerFd)
  }
}


if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => {
  // Never print arbitrary exception messages, URLs, manifests, or remote responses.
  console.error('weknora-agent-live: failed; inspect private attempt evidence; do not resubmit')
  process.exitCode = 1
})
