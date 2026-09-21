import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, ListToolsResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { BindingActor, BindingProvider, BindingResolver, McpToolApproval, ResolvedMcpBinding } from './bindings.js'
import { createProtocolFetch } from './protocol-http.js'

const DEADLINE_MS = 30_000
const INPUT_BYTES = 64 * 1024
const MAX_LIST_PAGES = 16

type ErrorCode = 'denied' | 'invalid_input' | 'schema_mismatch' | 'unsupported_schema' | 'unsupported_tool'
  | 'unsupported_content' | 'invalid_output' | 'credential_echo' | 'unavailable' | 'unknown'
export class McpToolError extends Error {
  constructor(readonly code: ErrorCode, readonly correlationId: string, readonly outcome: 'denied' | 'failed' | 'unknown') {
    super(`mcp tools: ${code}`)
    this.name = 'McpToolError'
  }
}

export interface McpApprovedTool {
  name: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  operatorReadOnly: true
  advertisedReadOnlyHint: boolean | null
  readOnlyBehaviorVerified: false
}
interface McpResultContext {
  correlationId: string
  binding: Pick<ResolvedMcpBinding, 'id' | 'version' | 'connectionId' | 'connectionVersion'>
  support: {
    transport: 'streamable-http'
    protocolVersion: string | null
    advertised: { tools: boolean; toolsListChanged: boolean; resources: boolean; prompts: boolean; tasks: boolean }
    verified: { initialize: true; toolsList: true; toolsCall: boolean }
    contentTrust: 'untrusted'
  }
}
export interface McpToolListResult extends McpResultContext { tools: McpApprovedTool[] }
export interface McpToolCallResult extends McpResultContext {
  tool: string
  status: 'completed' | 'failed'
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
}

/** Only reviewed schemas reach the compiler; no remote references are loaded. */
function compileSchema(schema: Record<string, unknown>): JsonSchemaValidator<Record<string, unknown>> {
  if (schema.$async !== undefined) throw new Error('unsupported_schema')
  const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false })
  addFormats(ajv)
  // A separate compiler per reviewed schema prevents $id reuse across tool definitions.
  return new AjvJsonSchemaValidator(ajv).getValidator<Record<string, unknown>>(schema)
}

/** Fixed per-call snapshot, rechecked before each network step. No pooling, reconnect or call retry. */
export class McpToolDispatcher {
  #bindings: BindingProvider
  #authorize: (actor: BindingActor) => Promise<void>

  constructor(bindings: BindingResolver | BindingProvider, authorize: (actor: BindingActor) => Promise<void>) {
    this.#bindings = typeof bindings === 'function' ? bindings : async () => bindings
    this.#authorize = authorize
  }

  list(actor: BindingActor, reauthorize?: () => Promise<void>): Promise<McpToolListResult> {
    return this.#perform('list', actor, undefined, undefined, reauthorize) as Promise<McpToolListResult>
  }

  call(actor: BindingActor, name: string, args: unknown, reauthorize?: () => Promise<void>): Promise<McpToolCallResult> {
    return this.#perform('call', actor, name, args, reauthorize) as Promise<McpToolCallResult>
  }

  async #perform(action: 'list' | 'call', actor: BindingActor, name: string | undefined, args: unknown, authorizeCall?: () => Promise<void>): Promise<McpToolListResult | McpToolCallResult> {
    const correlationId = randomUUID()
    const caller = Object.freeze({ companyId: actor.companyId, subjectId: actor.subjectId })
    const controller = new AbortController()
    let binding: ResolvedMcpBinding | undefined
    let transport: StreamableHTTPClientTransport | undefined
    let sent = false
    let outcome: 'completed' | 'failed' | 'denied' | 'unknown' = 'failed'
    let approvedName: string | null = null
    const fail = (code: ErrorCode) => new McpToolError(code, correlationId, sent ? 'unknown' : code === 'denied' ? 'denied' : 'failed')
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(fail(sent ? 'unknown' : 'unavailable')), { once: true })
    })
    const operation = async (): Promise<McpToolListResult | McpToolCallResult> => {
      if (action === 'call' && typeof name !== 'string') throw fail('denied')
      const selected = (await this.#bindings(caller))?.resolve(caller, 'mcp.tools', 'tool')
      if (!selected?.ok) throw fail('denied')
      const original = selected.binding
      binding = original
      const reauthorize = async () => {
        controller.signal.throwIfAborted()
        try { await this.#authorize(caller); await authorizeCall?.() } catch { throw fail('denied') }
        controller.signal.throwIfAborted()
        const current = (await this.#bindings(caller))?.resolve(caller, 'mcp.tools', 'tool')
        if (!current?.ok || !isDeepStrictEqual(current.binding, original)) throw fail('denied')
      }
      await reauthorize()
      const approved = new Map<string, { tool: McpToolApproval; input: JsonSchemaValidator<Record<string, unknown>>; output?: JsonSchemaValidator<Record<string, unknown>> }>()
      for (const tool of original.tools) {
        if (tool.readOnly !== true || approved.has(tool.name)) throw fail('denied')
        try {
          approved.set(tool.name, { tool, input: compileSchema(tool.inputSchema), ...(tool.outputSchema ? { output: compileSchema(tool.outputSchema) } : {}) })
        } catch { throw fail('unsupported_schema') }
      }
      if (!approved.size || (name !== undefined && !approved.has(name))) throw fail('denied')
      const target = name === undefined ? undefined : approved.get(name)!
      approvedName = target?.tool.name ?? null
      let parameters: Record<string, unknown> | undefined
      if (target) {
        try {
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('invalid_input')
          const json = JSON.stringify(args)
          if (Buffer.byteLength(json) > INPUT_BYTES) throw fail('invalid_input')
          parameters = JSON.parse(json) as Record<string, unknown>
          // Reject every lossy conversion (undefined, NaN, dates, toJSON, sparse arrays, etc.).
          if (!isDeepStrictEqual(args, parameters) || !target.input(parameters).valid) throw fail('invalid_input')
        } catch { throw fail('invalid_input') }
      }
      const requestOptions = { signal: controller.signal, timeout: DEADLINE_MS, maxTotalTimeout: DEADLINE_MS, resetTimeoutOnProgress: false }
      transport = new StreamableHTTPClientTransport(new URL(original.baseUrl), {
        fetch: createProtocolFetch(original.baseUrl, original.apiKey, reauthorize, controller.signal),
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      })
      // No roots, sampling, elicitation, tasks, or listChanged handlers are registered.
      const client = new Client({ name: 'cumora-mcp-tools', version: '1' }, { capabilities: {}, enforceStrictCapabilities: true })
      await client.connect(transport, requestOptions)
      const capabilities = client.getServerCapabilities()
      if (!capabilities?.tools) throw fail('unsupported_tool')
      const discovered = new Map<string, Tool>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; ; page++) {
        if (page >= MAX_LIST_PAGES) throw fail('schema_mismatch')
        // Client.listTools compiles every remote outputSchema. Discover through the SDK
        // request API instead; unapproved tools must never enter the validator cache.
        const result = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema, requestOptions)
        if (JSON.stringify(result).includes(JSON.stringify(original.apiKey).slice(1, -1))) throw fail('credential_echo')
        for (const tool of result.tools) {
          if (!approved.has(tool.name)) continue
          if (discovered.has(tool.name)) throw fail('schema_mismatch')
          const expected = approved.get(tool.name)!.tool
          if (!isDeepStrictEqual(tool.inputSchema, expected.inputSchema) || !isDeepStrictEqual(tool.outputSchema, expected.outputSchema)) throw fail('schema_mismatch')
          if (tool.execution?.taskSupport === 'required') throw fail('unsupported_tool')
          discovered.set(tool.name, tool)
        }
        if (result.nextCursor === undefined) break
        if (!result.nextCursor || cursors.has(result.nextCursor)) throw fail('schema_mismatch')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      if (discovered.size !== approved.size) throw fail('schema_mismatch')
      await reauthorize()
      const context: McpResultContext = {
        correlationId,
        binding: { id: original.id, version: original.version, connectionId: original.connectionId, connectionVersion: original.connectionVersion },
        support: {
          transport: 'streamable-http', protocolVersion: transport.protocolVersion ?? null,
          advertised: { tools: true, toolsListChanged: capabilities.tools.listChanged === true, resources: !!capabilities.resources, prompts: !!capabilities.prompts, tasks: !!capabilities.tasks },
          verified: { initialize: true, toolsList: true, toolsCall: false }, contentTrust: 'untrusted',
        },
      }
      if (!target) {
        return { ...context, tools: [...approved.values()].map(({ tool }) => ({
          name: tool.name, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          operatorReadOnly: true, advertisedReadOnlyHint: discovered.get(tool.name)!.annotations?.readOnlyHint ?? null, readOnlyBehaviorVerified: false,
        })) }
      }
      sent = true
      const result = await client.callTool({ name: target.tool.name, arguments: parameters }, CallToolResultSchema, requestOptions) as CallToolResult
      if (JSON.stringify(result).includes(JSON.stringify(original.apiKey).slice(1, -1))) throw fail('credential_echo')
      const content: McpToolCallResult['content'] = []
      for (const item of result.content) {
        if (item.type !== 'text') throw fail('unsupported_content')
        // Drop remote annotations, roles, metadata and any embedded-resource instructions.
        content.push({ type: 'text', text: item.text })
      }
      if (result.structuredContent !== undefined) {
        if (!target.output || !target.output(result.structuredContent).valid) throw fail('invalid_output')
      } else if (target.output && !result.isError) throw fail('invalid_output')
      await reauthorize()
      context.support.verified.toolsCall = true
      return { ...context, tool: target.tool.name, status: result.isError ? 'failed' : 'completed', content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) }
    }
    try {
      const result = await Promise.race([operation(), aborted])
      if (binding && JSON.stringify(result).includes(JSON.stringify(binding.apiKey).slice(1, -1))) throw fail('credential_echo')
      outcome = 'status' in result ? result.status : 'completed'
      return result
    } catch (error) {
      const safe = error instanceof McpToolError ? error
        : fail(error instanceof Error && error.message === 'credential_in_remote_payload' ? 'credential_echo' : sent ? 'unknown' : 'unavailable')
      outcome = safe.outcome
      throw safe
    } finally {
      clearTimeout(timer)
      controller.abort()
      await transport?.close().catch(() => {})
      // Only bounded identity fields. Never serialize an exception, URL, arguments or result.
      const auditId = (value: string | null | undefined) => value && /^[a-zA-Z0-9_.@-]{1,128}$/.test(value)
        && (!binding || !value.includes(binding.apiKey)) ? value : null
      console.info('[mcp-tools]', JSON.stringify({ correlationId, actor: { companyId: auditId(caller.companyId), subjectId: auditId(caller.subjectId) },
        bindingId: auditId(binding?.id), bindingVersion: auditId(binding?.version), connectionVersion: auditId(binding?.connectionVersion),
        operation: action, tool: auditId(approvedName), outcome }))
    }
  }
}

let installed: McpToolDispatcher | undefined
export function installMcpTools(dispatcher: McpToolDispatcher | undefined): void { installed = dispatcher }
export function getMcpTools(): McpToolDispatcher | undefined { return installed }
