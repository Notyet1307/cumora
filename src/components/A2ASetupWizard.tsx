import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, ws } from '@/api/client'
import type { A2ADiscovery, IntegrationManagementView } from '@/integration-types'
import { a2aSetupConfig, a2aSetupEnabled, a2aTrialResult, type A2ASetupIdentity, type A2ATrialIdentity, type A2ATrialResult } from '@/lib/a2a-setup'
import { useT } from '@/lib/i18n'
import { useApp } from '@/stores/app'
import { useConversations } from '@/stores/conversations'

const inputClass = 'mt-1 w-full min-w-0 rounded-[8px] border border-ink-100 bg-paper px-3 py-2 text-[12px] text-ink-800 focus:border-skype disabled:opacity-50'
const buttonClass = 'rounded-[8px] border border-ink-100 px-3 py-2 text-[12px] font-semibold text-ink-600 hover:bg-cloud disabled:opacity-40'
const primaryClass = 'rounded-[8px] bg-skype px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40'
const cardClass = 'min-w-0 rounded-[10px] border border-ink-100 bg-paper p-4'

export function A2ASetupWizard({ companyId, view, onViewChange, onPublished, onClose, onOpenConversation }: {
  companyId: string
  view: IntegrationManagementView
  onViewChange: (view: IntegrationManagementView) => void
  onPublished: (view: IntegrationManagementView) => void
  onClose: () => void
  onOpenConversation?: () => void
}) {
  const t = useT()
  const targets = view.targets.filter(target => target.backend === 'a2a')
  const [targetIndex, setTargetIndex] = useState(targets.length === 1 ? '0' : '')
  const [discovery, setDiscovery] = useState<A2ADiscovery | null>(null)
  const [name, setName] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [trial, setTrial] = useState<A2ATrialIdentity | null>(null)
  const [result, setResult] = useState<A2ATrialResult>({ status: 'pending' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const identity = useRef<A2ASetupIdentity | null>(null)
  const trialRef = useRef<A2ATrialIdentity | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  const readGeneration = useRef(0)
  const statusRef = useRef<HTMLDivElement>(null)
  const target = targetIndex === '' ? undefined : targets[Number(targetIndex)]
  const step = enabled ? 2 : discovery ? 1 : 0

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; readGeneration.current++ }
  }, [])
  useEffect(() => { if (error) statusRef.current?.scrollIntoView({ block: 'nearest' }) }, [error])

  const run = async (action: string, operation: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true; setBusy(action); setError(null)
    try { await operation() } catch (reason) {
      if (alive.current) setError(t(reason instanceof ApiError
        ? reason.message.startsWith('integration_member_quota') ? 'a2a.quota'
          : reason.status === 403 ? 'integrations.forbidden' : reason.status === 409 ? 'integrations.conflict'
            : reason.status === 400 ? 'integrations.invalidPolicy' : reason.status === 502 ? 'a2a.discoveryFailed' : 'integrations.failed'
        : 'integrations.failed'))
    } finally { locked.current = false; if (alive.current) setBusy(null) }
  }

  const discover = () => void run('discover', async () => {
    if (!target) return
    setDiscovery(null); setReviewed(false)
    const current = await api.getIntegrations()
    if (!alive.current) return
    onViewChange(current)
    const approved = current.targets.find(item => JSON.stringify(item) === JSON.stringify(target))
    if (!approved) throw new ApiError('integration_invalid_policy', 400)
    const found = await api.discoverA2AIntegration(current.revision, approved)
    if (!alive.current) return
    setDiscovery(found); setName(identity.current?.name ?? found.card.name)
  })

  const publish = () => void run('publish', async () => {
    if (!discovery || !reviewed || !name.trim()) return
    const attempt = identity.current ?? { requestId: crypto.randomUUID(), connectionId: `a2a-${crypto.randomUUID()}`,
      bindingId: `a2a-${crypto.randomUUID()}`, name: name.trim() }
    identity.current = attempt
    const accept = (saved: IntegrationManagementView) => {
      if (!alive.current) return
      onPublished(saved); setEnabled(true); setError(null)
    }
    try {
      if (!attempt.memberId) attempt.memberId = (await api.createIntegrationMember(attempt.name, attempt.requestId)).id
      if (!alive.current) return
      const config = a2aSetupConfig(view.config, companyId, discovery, attempt, attempt.memberId)
      const saved = await api.saveIntegrations(discovery.revision, config)
      if (!a2aSetupEnabled(saved, companyId, discovery, attempt)) throw new Error('a2a_setup_not_enabled')
      accept(saved)
    } catch (reason) {
      // A lost save response may already have committed. Read it, never blindly republish.
      if (!alive.current) return
      const current = await api.getIntegrations()
      if (!alive.current) return
      onViewChange(current)
      if (a2aSetupEnabled(current, companyId, discovery, attempt)) { accept(current); return }
      setDiscovery(null); setReviewed(false)
      throw reason
    }
  })

  const refreshTrial = useCallback(async () => {
    const attempt = trialRef.current
    if (!attempt) return
    const generation = ++readGeneration.current
    try {
      const messages = await api.getMessages(attempt.conversationId, { limit: 100 })
      const pending = a2aTrialResult(messages, attempt)
      const current = pending.deliveryId ? await api.getExternalDelivery(pending.deliveryId) : undefined
      if (!alive.current || generation !== readGeneration.current) return
      setResult(a2aTrialResult(messages, attempt, current)); setError(null)
    } catch (reason) {
      if (!alive.current || generation !== readGeneration.current) return
      setResult({ status: reason instanceof ApiError && (reason.status === 403 || reason.status === 404) ? 'withheld' : 'unknown' })
      setError(t('a2a.trialUnconfirmed'))
    }
  }, [t])

  // Subscribe before a trial can be submitted; reconnects reconcile by reading history.
  useEffect(() => ws.on(event => {
    const attempt = trialRef.current
    if (attempt && (event.type === 'hello' || ((event.type === 'message.new' || event.type === 'external.delivery')
      && event.conversationId === attempt.conversationId))) void refreshTrial()
  }), [refreshTrial])

  const sendTrial = () => void run('trial', async () => {
    const memberId = identity.current?.memberId
    if (!enabled || !memberId || trialRef.current || !prompt.trim() || prompt.length > 8000) return
    const direct = await api.openDirect(memberId)
    if (!alive.current) return
    const attempt: A2ATrialIdentity = { conversationId: direct.id, memberId, clientId: crypto.randomUUID() }
    trialRef.current = attempt; setTrial(attempt); setResult({ status: 'pending' })
    try {
      const sent = await api.sendMessage(direct.id, prompt, null, null, attempt.clientId)
      attempt.sourceId = sent.id
      if (alive.current) setTrial({ ...attempt })
      await refreshTrial()
    } catch {
      // Submission may have reached the server. Preserve its clientId and only read from here.
      if (alive.current) { setResult({ status: 'unknown' }); setError(t('a2a.trialUnconfirmed')) }
    }
  })

  const openChat = () => void run('chat', async () => {
    const memberId = identity.current?.memberId
    if (!memberId) return
    const conversationId = trialRef.current?.conversationId ?? (await api.openDirect(memberId)).id
    await useConversations.getState().reload()
    if (!alive.current) return
    useApp.getState().setView('conversations')
    useApp.getState().selectConversation(conversationId)
    onOpenConversation?.()
  })

  return <section className="min-w-0 space-y-4 p-4 sm:p-5" aria-label={t('a2a.title')} aria-busy={busy !== null}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="text-[15px] font-semibold text-ink-800">{t('a2a.title')}</h3>
        <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink-500">{t('a2a.intro')}</p></div>
      <button type="button" className={buttonClass} disabled={busy !== null} onClick={onClose}>{t('a2a.back')}</button>
    </header>
    <ol className="grid grid-cols-3 gap-2" aria-label={t('a2a.steps')}>
      {(['a2a.discoverStep', 'a2a.approveStep', 'a2a.trialStep'] as const).map((key, index) => <li key={key}
        aria-current={step === index ? 'step' : undefined}
        className={`rounded-[8px] px-2 py-2 text-center text-[11px] font-semibold sm:text-[12px] ${step === index ? 'bg-skype text-white' : 'bg-cloud text-ink-500'}`}>
        {index + 1}. {t(key)}
      </li>)}
    </ol>
    <div ref={statusRef} aria-live="polite" className="scroll-mt-24">
      {busy && <p role="status" className="text-[12px] text-ink-500">{t('integrations.working')}</p>}
      {error && <p role="alert" className="break-words rounded-[8px] bg-coral-soft/40 p-3 text-[12px] text-coral-deep">{error}</p>}
    </div>
    {!enabled && <>
      <form className={`${cardClass} space-y-3`} onSubmit={event => { event.preventDefault(); discover() }}>
        <label className="block text-[12px] font-medium text-ink-600">{t('integrations.target')}
          <select className={inputClass} value={targetIndex} required disabled={busy !== null} onChange={event => {
            setTargetIndex(event.target.value); setDiscovery(null); setReviewed(false); setError(null)
          }}>
            <option value="">{t('integrations.chooseTarget')}</option>
            {targets.map((item, index) => <option key={index} value={index}>{item.baseUrl} · {item.remoteAgentIds.join(', ')}</option>)}
          </select>
        </label>
        {!targets.length && <p className="text-[12px] leading-relaxed text-ink-500">{t('integrations.noTargets')}</p>}
        <p className="text-[11px] leading-relaxed text-ink-400">{t('a2a.discoveryHelp')}</p>
        <button type="submit" className={primaryClass} disabled={!target || busy !== null}>{t(discovery ? 'a2a.rediscover' : 'a2a.discover')}</button>
      </form>
      {discovery && <form className={`${cardClass} space-y-4`} onSubmit={event => { event.preventDefault(); publish() }}>
        <div><p className="text-[11px] font-semibold text-ink-400">{t('a2a.metadata')}</p>
          <h4 className="mt-1 break-words text-[15px] font-semibold text-ink-800">{discovery.card.name}</h4>
          <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-600">{discovery.card.description}</p></div>
        <dl className="grid min-w-0 grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
          <div><dt className="text-ink-400">{t('a2a.skill')}</dt><dd className="break-words text-ink-800">{discovery.card.skill.name} · {discovery.card.skill.id}</dd></div>
          <div><dt className="text-ink-400">{t('a2a.protocol')}</dt><dd className="text-ink-800">A2A {discovery.card.protocolVersion} · JSON-RPC</dd></div>
          <div><dt className="text-ink-400">{t('a2a.input')}</dt><dd className="break-all text-ink-700">{discovery.card.inputModes.join(', ')}</dd></div>
          <div><dt className="text-ink-400">{t('a2a.output')}</dt><dd className="break-all text-ink-700">{discovery.card.outputModes.join(', ')}</dd></div>
        </dl>
        <p className="rounded-[8px] bg-cloud p-3 text-[11px] leading-relaxed text-ink-600">{t('a2a.limits')}</p>
        <details className="text-[11px] text-ink-500"><summary className="cursor-pointer font-medium">{t('a2a.details')}</summary>
          <dl className="mt-2 space-y-2">
            <div><dt>{t('integrations.endpoint')}</dt><dd className="break-all">{discovery.target.baseUrl}</dd></div>
            <div><dt>SHA-256</dt><dd className="break-all font-mono">{discovery.card.cardSha256}</dd></div>
            <div><dt>{t('integrations.credentialRevision')}</dt><dd>{discovery.target.secretRef} / {discovery.target.credentialRevision}</dd></div>
          </dl>
        </details>
        <label className="block text-[12px] font-medium text-ink-600">{t('integrations.memberName')}
          <input className={inputClass} value={name} required maxLength={80} disabled={busy !== null || identity.current !== null}
            onChange={event => { setName(event.target.value); setReviewed(false) }} />
        </label>
        {identity.current && <p className="text-[11px] leading-relaxed text-ink-500">{t('a2a.resumeCreation')}</p>}
        <label className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-700">
          <input type="checkbox" className="mt-0.5 shrink-0" checked={reviewed} required disabled={busy !== null} onChange={event => setReviewed(event.target.checked)} />
          <span>{t('a2a.approval')}</span>
        </label>
        <p className="text-[11px] leading-relaxed text-ink-400">{t('integrations.publishHelp')}</p>
        <button type="submit" className={primaryClass} disabled={!reviewed || !name.trim() || busy !== null || view.config.connections.length >= 64 || view.config.bindings.length >= 128}>{t('a2a.enable')}</button>
      </form>}
    </>}
    {enabled && <div className="space-y-3">
      <div className={`${cardClass} bg-cloud/40`}><h4 className="break-words text-[14px] font-semibold text-ink-800">{t('a2a.enabled', { name: identity.current?.name ?? name })}</h4>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-500">{t('a2a.enabledHelp')}</p></div>
      <form className={`${cardClass} space-y-3`} onSubmit={event => { event.preventDefault(); sendTrial() }}>
        <label className="block text-[12px] font-medium text-ink-600">{t('a2a.trialPrompt')}
          <textarea className={inputClass} rows={4} required maxLength={8000} value={prompt} disabled={busy !== null || trial !== null}
            placeholder={t('a2a.trialPlaceholder')} onChange={event => setPrompt(event.target.value)} />
        </label>
        <p className="text-[11px] leading-relaxed text-ink-500">{t('a2a.trialHelp')}</p>
        <div className="flex flex-wrap gap-2">
          {!trial && <button type="submit" className={primaryClass} disabled={busy !== null || !prompt.trim()}>{t('a2a.sendTrial')}</button>}
          {trial && <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => void run('refresh', refreshTrial)}>{t('a2a.checkResult')}</button>}
          <button type="button" className={buttonClass} disabled={busy !== null} onClick={openChat}>{t('a2a.openChat')}</button>
        </div>
      </form>
      {trial && <section className={`${cardClass} space-y-2`} aria-label={t('a2a.trialResult')} aria-live="polite">
        <h4 role="status" className="text-[13px] font-semibold text-ink-800">{t(`a2a.result.${result.status}`)}</h4>
        {result.status === 'completed'
          ? <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-700">{result.answer}</p>
          : <p className="text-[12px] leading-relaxed text-ink-500">{t(result.status === 'pending' ? 'a2a.pendingHelp' : 'a2a.noReplay')}</p>}
      </section>}
    </div>}
  </section>
}
