import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { BindingConfig } from '../integrations/bindings.js'

export const FIXTURE_AGENT_ID = '11111111-1111-4111-8111-111111111111'
export const FIXTURE_ANSWER = `${'本地协议 fixture：第 39 条要求完整记录审查依据。\n\n'.repeat(120)}结论：保留全部证据。<kb doc="模型标题不可信" chunk_id="chunk-39" kb_id="kb-test"/>`

/** Explicit loopback-only upstream. No real credentials, proxying, or model calls. */
export class ExternalAgentFixture {
  server: Server
  baseUrl = ''
  requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  answer = FIXTURE_ANSWER
  mode: 'complete' | 'unknown' | 'mismatch' | 'wrong-source' = 'complete'
  hold = false
  pauseAt: 'session' | 'history' | null = null
  #resume: Array<() => void> = []
  #sessions = 0
  #calls = 0
  #messages = new Map<string, Record<string, unknown>[]>()
  constructor() {
    this.server = createServer(async (req, res) => {
      if (req.headers['x-api-key'] !== 'fixture-chat-only') { res.writeHead(403).end(); return }
      let body = ''
      for await (const chunk of req) {
        body += String(chunk)
        if (body.length > 64 * 1024) { res.writeHead(413).end(); return }
      }
      let parsed: Record<string, unknown>
      try { parsed = body ? JSON.parse(body) : {} } catch { res.writeHead(400).end(); return }
      const path = req.url ?? ''
      this.requests.push({ method: req.method ?? '', path, body: parsed })
      if (req.method === 'POST' && path === '/api/v1/sessions') {
        this.server.emit('session-requested')
        if (this.pauseAt === 'session') await new Promise<void>(resolve => this.#resume.push(resolve))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: true, data: { id: `session-${++this.#sessions}` } })); return
      }
      const submit = /^\/api\/v1\/agent-chat\/(session-\d+)$/.exec(path)
      if (req.method === 'POST' && submit) {
        const call = ++this.#calls
        const session = submit[1]
        const assistant = `assistant-${call}`
        const answer = this.answer
        const mode = this.mode
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const event = (value: Record<string, unknown>) => res.write(`data: ${JSON.stringify(value)}\n\n`)
        event({ response_type: 'agent_query', done: true, session_id: session, assistant_message_id: assistant, id: `request-${call}`,
          data: { user_message_id: `user-${call}` } })
        this.server.emit('submitted')
        if (this.hold) await new Promise<void>(resolve => this.#resume.push(resolve))
        if (mode === 'unknown') { res.end(); return }
        this.#messages.set(session, [{ id: assistant, session_id: session, role: 'assistant', is_completed: true,
          agent_id: FIXTURE_AGENT_ID, content: mode === 'mismatch' ? 'different answer' : answer,
          agent_steps: [{ iteration: 1, tool_calls: [{ id: `search-${call}`, name: 'knowledge_search', result: {
            success: true, data: { results: [{ knowledge_base_id: mode === 'wrong-source' ? 'other-kb' : 'kb-test', knowledge_id: 'doc-39',
              chunk_id: 'chunk-39', chunk_index: 39, knowledge_title: '合成审查规范 · 第 39 条', content: '第 39 条：完整记录审查依据。仅为本地合成材料。' }] },
          } }] }] }])
        event({ response_type: 'answer', content: answer, data: { event_id: `answer-${call}` } })
        event({ response_type: 'complete', done: true }); res.end(); return
      }
      const history = /^\/api\/v1\/messages\/(session-\d+)\/load\?limit=2$/.exec(path)
      if (req.method === 'GET' && history) {
        this.server.emit('history-requested')
        if (this.pauseAt === 'history') await new Promise<void>(resolve => this.#resume.push(resolve))
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ success: true, data: this.#messages.get(history[1]) ?? [] })); return
      }
      res.writeHead(404).end()
    })
  }
  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('loopback_fixture_failed')
    this.baseUrl = `http://127.0.0.1:${address.port}/api/v1`
  }
  resume(): void { this.hold = false; this.pauseAt = null; for (const resolve of this.#resume.splice(0)) resolve() }
  async close(): Promise<void> { this.resume(); this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())) }
  config(companyId: string, memberId: string): BindingConfig {
    return { schemaVersion: 1,
      connections: [{ id: 'fixture', version: '1', kind: 'agent-service', backend: 'weknora', baseUrl: this.baseUrl,
        secretRef: 'fixture-chat', credentialRevision: '1', knowledgeBaseIds: ['kb-test'], enabled: true }],
      bindings: [{ id: 'fixture-member', version: '1', connectionId: 'fixture', connectionVersion: '1', kind: 'agent-service',
        capabilityId: 'weknora.agent', companyIds: [companyId], subjectIds: [memberId], enabled: true, remoteAgentId: FIXTURE_AGENT_ID,
        approval: { authorizationVersion: '1', tenantId: 'fixture', effectiveConfigDigest: 'a'.repeat(64), mode: 'smart-reasoning',
          allowedTools: ['knowledge_search'], credentialCapability: 'chat', kbSelectionMode: 'selected', retrieveKbOnlyWhenMentioned: false,
          mcpSelectionMode: 'none', skillsSelectionMode: 'none', sandboxEnabled: false, memoryEnabled: false } }] }
  }
}
