import type { BindingActor, ResolvedAgentBinding } from './bindings.js'
import type { InvocationStore, Invocation, InvocationSnapshot } from './invocations.js'
import { AGENT_LIMITS, WeknoraAgentClient, type AgentResult } from './weknora-agent.js'

export function bindingSnapshot(binding: ResolvedAgentBinding): InvocationSnapshot {
  return { bindingId: binding.id, bindingVersion: binding.version, connectionId: binding.connectionId,
    connectionVersion: binding.connectionVersion, authorizationVersion: binding.approval.authorizationVersion,
    remoteAgentId: binding.remoteAgentId, tenantId: binding.approval.tenantId, knowledgeBaseIds: [...binding.knowledgeBaseIds],
    effectiveConfigDigest: binding.approval.effectiveConfigDigest }
}

/** Execute exactly one previously committed claim. No retries, transactions across I/O, or native fallback. */
export async function executeClaim(store: InvocationStore, actor: BindingActor, owned: Invocation,
  binding: ResolvedAgentBinding, authorize: () => void | Promise<void>,
  validate?: (result: AgentResult, client: WeknoraAgentClient, signal: AbortSignal) => Promise<Record<string, unknown>>): Promise<void> {
  const signal = AbortSignal.timeout(AGENT_LIMITS.totalMs)
  const client = new WeknoraAgentClient(binding, authorize)
  let possibleRemoteEffect = false
  try {
    await authorize()
    let sessionId = await store.session(actor, owned)
    if (!sessionId) {
      possibleRemoteEffect = true
      sessionId = await client.createSession(signal)
    }
    await store.saveSession(actor, owned, sessionId)
    await authorize()
    possibleRemoteEffect = true
    const result = await client.submit(sessionId, owned.input_text!, ids => store.saveIds(actor, owned.id, owned.generation, ids), signal)
    // Hold the active lease until the owned assistant and same-turn evidence are durable.
    const checked = validate ? await validate(result, client, signal) : result
    await store.saveResult(actor, owned.id, owned.generation, checked)
  } catch {
    try {
      if (possibleRemoteEffect) await store.markUnknown(actor, owned.id, owned.generation)
      else await store.saveResult(actor, owned.id, owned.generation, { status: 'failed', limitations: ['rejected_before_remote_submit'] })
    } catch { throw new Error('persistence_unconfirmed_no_retry') }
  }
}
