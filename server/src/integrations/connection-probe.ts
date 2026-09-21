import type { IntegrationProbeResult } from '../../../src/integration-types.js'
import type { BindingActor, BindingResolver } from './bindings.js'
import { A2AAgentClient } from './a2a-agent.js'
import { McpToolDispatcher } from './mcp-tools.js'
import { WeknoraAgentClient } from './weknora-agent.js'

/** Explicit metadata requests only. Accepted credentials are not proof that a server enforces authentication. */
export async function probeIntegration(
  resolver: BindingResolver, actor: BindingActor, reauthorize: () => Promise<void>,
  capability: 'weknora.agent' | 'a2a.agent' | 'mcp.tools',
): Promise<IntegrationProbeResult> {
  const result: IntegrationProbeResult = { connectivity: 'not_verified', authentication: 'not_verified',
    permission: 'not_verified', business: 'not_verified', code: 'metadata_unavailable' }
  try {
    await reauthorize()
    if (capability === 'mcp.tools') {
      await new McpToolDispatcher(resolver, reauthorize).list(actor)
      result.permission = 'pass'
    } else if (capability === 'a2a.agent') {
      const selected = resolver.resolve(actor, 'a2a.agent', 'agent-service')
      if (!selected.ok) return { ...result, permission: 'fail', code: 'binding_denied' }
      await new A2AAgentClient(selected.binding, reauthorize).preflight(AbortSignal.timeout(30_000))
      result.permission = 'pass'
    } else {
      const selected = resolver.resolve(actor, 'weknora.agent', 'agent-service')
      if (!selected.ok) return { ...result, permission: 'fail', code: 'binding_denied' }
      await new WeknoraAgentClient(selected.binding, reauthorize).preflight(AbortSignal.timeout(30_000))
      // Metadata access is not evidence that this credential may use chat or the selected KBs.
    }
    await reauthorize()
    return { ...result, connectivity: 'pass', code: 'metadata_only_business_not_verified' }
  } catch {
    // No raw upstream errors, URLs, credentials or payloads are exposed.
    return result
  }
}
