import type { BindingResolver, BindingActor, ResolvedAgentBinding } from './bindings.js'
import type { InvocationStore, Invocation, InvocationSnapshot } from './invocations.js'
import { AGENT_LIMITS, WeknoraAgentClient, type RemoteIds } from './weknora-agent.js'
import { bindingSnapshot, executeClaim } from './agent-execution.js'


/** Trusted operator-only entry. No HTTP route, CLI verb, native engine, or default credentials. */
export class OperatorAgent {
  readonly #bindings: BindingResolver
  readonly #store: InvocationStore
  constructor(bindings: BindingResolver, store: InvocationStore) { this.#bindings = bindings; this.#store = store }

  #binding(actor: BindingActor, record?: Invocation): ResolvedAgentBinding {
    if (['compliance', 'reporter'].includes(actor.subjectId)) throw new Error('operator_subject_required')
    const selected = this.#bindings.resolve(actor, 'weknora.agent', 'agent-service')
    if (!selected.ok) throw new Error(`binding_${selected.code}`)
    if (record) {
      const current = bindingSnapshot(selected.binding)
      if ((Object.keys(current) as Array<keyof InvocationSnapshot>).some(key => JSON.stringify(record.snapshot[key]) !== JSON.stringify(current[key]))) throw new Error('authorization_changed')
    }
    return selected.binding
  }

  async get(actor: BindingActor, invocationId: string): Promise<Invocation> {
    this.#binding(actor)
    await this.#store.expireLeases(actor)
    await this.#store.purgeExpired()
    const record = await this.#store.get(actor, invocationId)
    if (!record) throw new Error('invocation_not_found')
    this.#binding(actor, record)
    return record
  }

  async submit(actor: BindingActor, input: { sourceId: string; conversationScope: string; query: string }): Promise<Invocation> {
    const binding = this.#binding(actor)
    await this.#store.purgeExpired()
    const accepted = await this.#store.accept(actor, { ...input, snapshot: bindingSnapshot(binding) })
    this.#binding(actor, accepted)
    if (accepted.status !== 'queued') return this.get(actor, accepted.id)
    const owned = await this.#store.claim(actor, accepted.id)
    if (!owned) return this.get(actor, accepted.id)
    await executeClaim(this.#store, actor, owned, binding, () => { this.#binding(actor, owned) })
    return this.get(actor, owned.id)
  }

  /** One explicitly requested read-only replay; never creates a Session or resubmits a query. */
  async observe(actor: BindingActor, invocationId: string): Promise<Invocation> {
    const record = await this.get(actor, invocationId)
    if (record.status !== 'unknown') return record
    const owned = await this.#store.claim(actor, invocationId, true)
    if (!owned) return this.get(actor, invocationId)
    const binding = this.#binding(actor, owned)
    const client = new WeknoraAgentClient(binding, () => { this.#binding(actor, owned) })
    try {
      const replay = await client.observe(owned.remote_ids as RemoteIds, ids => this.#store.saveIds(actor, owned.id, owned.generation, ids), AbortSignal.timeout(AGENT_LIMITS.totalMs))
      const result = replay.status === 'unknown' && owned.result
        ? { ...owned.result, status: 'unknown', limitations: ['observation_inconclusive_previous_partial_retained'] }
        : replay
      await this.#store.saveResult(actor, owned.id, owned.generation, result)
    } catch {
      try { await this.#store.markUnknown(actor, owned.id, owned.generation) } catch { throw new Error('persistence_unconfirmed_no_retry') }
    }
    return this.get(actor, invocationId)
  }

  async cancelQueued(actor: BindingActor, invocationId: string): Promise<Invocation> {
    await this.get(actor, invocationId)
    await this.#store.cancelQueued(actor, invocationId)
    return this.get(actor, invocationId)
  }

  /** Explicit stop records observations; a 200 never marks a running invocation canceled. */
  async stop(actor: BindingActor, invocationId: string): Promise<Invocation> {
    const record = await this.get(actor, invocationId)
    if (record.status === 'queued') return this.cancelQueued(actor, invocationId)
    if (!await this.#store.requestStop(actor, invocationId)) return this.get(actor, invocationId)
    const binding = this.#binding(actor, record)
    const client = new WeknoraAgentClient(binding, () => { this.#binding(actor, record) })
    let accepted: boolean | null = null
    try { accepted = (await client.stop(record.remote_ids as RemoteIds, AbortSignal.timeout(AGENT_LIMITS.totalMs))).accepted } catch { /* Remote observation remains uncertain. */ }
    await this.#store.recordStop(actor, invocationId, { httpAccepted: accepted })
    return this.get(actor, invocationId)
  }
}
