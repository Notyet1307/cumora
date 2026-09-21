import type { BindingActor, ResolvedExternalAgentBinding } from './bindings.js'
import type { InvocationStore, Invocation, InvocationSnapshot } from './invocations.js'
import { AGENT_LIMITS, WeknoraAgentClient } from './weknora-agent.js'
import { A2AAgentClient } from './a2a-agent.js'
import { requireAnswer, sourceEvidence } from './agent-evidence.js'

export function bindingSnapshot(binding: ResolvedExternalAgentBinding): InvocationSnapshot {
  return { bindingId: binding.id, bindingVersion: binding.version, connectionId: binding.connectionId,
    connectionVersion: binding.connectionVersion, authorizationVersion: binding.approval.authorizationVersion,
    remoteAgentId: binding.remoteAgentId, tenantId: binding.approval.tenantId, knowledgeBaseIds: [...binding.knowledgeBaseIds],
    effectiveConfigDigest: binding.approval.effectiveConfigDigest }
}

/** Execute one durable claim. Protocol knowledge stays here, not in member/chat/scheduler paths. */
export async function executeClaim(store: InvocationStore, actor: BindingActor, owned: Invocation,
  binding: ResolvedExternalAgentBinding, authorize: () => void | Promise<void>, publication = false): Promise<void> {
  const signal = AbortSignal.timeout(AGENT_LIMITS.totalMs)
  let possibleRemoteEffect = false
  try {
    await authorize()
    if (binding.backend === 'a2a') {
      const client = new A2AAgentClient(binding, authorize)
      const contextId = await store.session(actor, owned)
      const result = await client.submit({ input: owned.input_text!, messageId: owned.id, ...(contextId ? { contextId } : {}) }, async ids => {
        if (ids.contextId) await store.saveSession(actor, owned, ids.contextId, 'contextId')
        await store.saveIds(actor, owned.id, owned.generation, ids)
      }, signal, () => { possibleRemoteEffect = true })
      await store.saveResult(actor, owned.id, owned.generation, { ...result, validation: {
        ...result.validation, evidence: { ...result.validation.evidence, invocationId: owned.id,
          remoteIds: result.ids, remoteAnswerMatches: result.validation.ok },
      } })
      return
    }
    const client = new WeknoraAgentClient(binding, authorize)
    let sessionId = await store.session(actor, owned)
    if (!sessionId) {
      possibleRemoteEffect = true
      sessionId = await client.createSession(signal)
    }
    await store.saveSession(actor, owned, sessionId)
    await authorize()
    possibleRemoteEffect = true
    const result = await client.submit(sessionId, owned.input_text!, ids => store.saveIds(actor, owned.id, owned.generation, ids), signal)
    let checked: Record<string, unknown> = result
    if (publication && result.status === 'completed') {
      try {
        requireAnswer({ status: result.status, result })
        if (!result.evidence.complete || !result.ids) throw new Error('complete_ids_required')
        const evidence = sourceEvidence(await client.history(result.ids, signal), { id: owned.id, remote_ids: result.ids, result }, {
          remoteAgentId: binding.remoteAgentId, knowledgeBaseIds: binding.knowledgeBaseIds, allowedTools: binding.approval.allowedTools,
        })
        checked = { ...result, validation: { ok: true, evidence: { ...evidence, remoteIds: result.ids } } }
      } catch { checked = { ...result, validation: { ok: false, reason: 'answer_validation_failed' } } }
    }
    await store.saveResult(actor, owned.id, owned.generation, checked)
  } catch {
    try {
      if (possibleRemoteEffect) await store.markUnknown(actor, owned.id, owned.generation)
      else await store.saveResult(actor, owned.id, owned.generation, { status: 'failed', limitations: ['rejected_before_remote_submit'] })
    } catch { throw new Error('persistence_unconfirmed_no_retry') }
  }
}
