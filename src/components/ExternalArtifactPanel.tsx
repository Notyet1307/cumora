import { useContext, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { useApp } from '@/stores/app'
import { useAuth, useMe } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import type { ArtifactView } from '../../shared/external-artifacts'
import { ArtifactConversationContext, ARTIFACTS_CHANGED } from './ArtifactConversation'
import { ArtifactReader } from './ArtifactReader'

const button = 'rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 disabled:opacity-50'
const control = 'mt-1 w-full rounded-lg border border-ink-200 bg-white p-2 text-ink-800 disabled:opacity-50'

export function ExternalArtifactPanel({ deliveryId, conversationId }: { deliveryId: string; conversationId: string }) {
  const epoch = useAuth(state => state.contextEpoch)
  return <SourceEntry key={`${epoch}:${conversationId}:${deliveryId}`} deliveryId={deliveryId} conversationId={conversationId} />
}

function SourceEntry({ deliveryId, conversationId }: { deliveryId: string; conversationId: string }) {
  const metadata = useContext(ArtifactConversationContext)
  const epoch = useAuth(state => state.contextEpoch)
  const me = useMe()
  const participants = useParticipants(state => state.byId)
  const [standalone, setStandalone] = useState<ArtifactView[]>([])
  const [opened, setOpened] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [reader, setReader] = useState<string | null>(null)
  const [receiver, setReceiver] = useState('')
  const [instructions, setInstructions] = useState('')
  const [target, setTarget] = useState('')
  const [title, setTitle] = useState('')
  const [captureExpired, setCaptureExpired] = useState(false)
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(false)
  const mutation = useRef(false)
  const request = useRef<{ payload: string; id: string } | null>(null)
  const current = () => mounted.current && useAuth.getState().contextEpoch === epoch && useApp.getState().selectedConversationId === conversationId
  const artifacts = metadata?.artifacts ?? standalone
  const owned = artifacts.filter(item => item.ownerId === me && item.sourceConversationId === conversationId)
  const saved = owned.find(item => item.versions.some(version => version.sourceDeliveryId === deliveryId))
  const source = saved?.versions.find(version => version.sourceDeliveryId === deliveryId)
  const handoffs = saved?.handoffs.filter(item => item.sourceVersion === source?.version) ?? []
  const expired = Boolean(saved && (saved.expired || Date.parse(saved.expiresAt) <= now))
  const recipients = Object.values(participants).filter(person => person.kind === 'agent' && person.executionKind === 'native' && person.executionEnabled === true && !person.departedAt)
  const pending = artifacts.some(item => !item.expired && Date.parse(item.expiresAt) > now && item.handoffs.some(handoff => handoff.status === 'assigned' || handoff.status === 'submitted'))
  const disabled = busy || loading || Boolean(metadata?.loading || metadata?.error)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(Date.parse(saved.expiresAt) - Date.now() + 1, 2_147_483_647)))
    return () => window.clearTimeout(timer)
  }, [saved])

  useEffect(() => {
    if (metadata || !opened) return
    const reload = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') setStandalone(items => items.filter(item => item.id !== event.detail))
      setRefresh(value => value + 1)
    }
    window.addEventListener('focus', reload)
    window.addEventListener(ARTIFACTS_CHANGED, reload)
    const timer = pending ? window.setInterval(() => setRefresh(value => value + 1), 5000) : undefined
    return () => {
      window.removeEventListener('focus', reload)
      window.removeEventListener(ARTIFACTS_CHANGED, reload)
      window.clearInterval(timer)
    }
  }, [metadata, opened, pending])

  useEffect(() => {
    if (metadata || !opened || busy) return
    let active = true
    setLoading(true)
    api.listExternalArtifacts().then(result => {
      if (active && mounted.current && useAuth.getState().contextEpoch === epoch && useApp.getState().selectedConversationId === conversationId) {
        setStandalone(result.artifacts)
        setError('')
      }
    }).catch(err => {
      if (active && mounted.current && useAuth.getState().contextEpoch === epoch && useApp.getState().selectedConversationId === conversationId) {
        setStandalone([])
        setReader(null)
        setError(err instanceof Error ? err.message : '无法读取成果，请重试。')
      }
    }).finally(() => { if (active && mounted.current && useAuth.getState().contextEpoch === epoch) setLoading(false) })
    return () => { active = false }
  }, [metadata, opened, busy, refresh, epoch, conversationId])

  const run = async (action: () => Promise<void>) => {
    if (mutation.current || !current()) return
    mutation.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await action() } catch (err) {
      if (current()) {
        setError(err instanceof ApiError && err.status === 409 ? '输入或交接状态已变化，请刷新并核对固定版本后重试。' : err instanceof Error ? err.message : '请求失败，请重试。')
        if (err instanceof ApiError && [403, 404, 410].includes(err.status)) {
          setReader(null)
          setStandalone([])
          if (saved) window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: saved.id }))
          if (err.status === 410) setCaptureExpired(true)
        }
      }
    } finally {
      mutation.current = false
      if (current()) {
        setBusy(false)
        setRefresh(value => value + 1)
        window.dispatchEvent(new Event(ARTIFACTS_CHANGED))
      }
    }
  }

  const capture = (artifactId?: string) => void run(async () => {
    const destination = artifactId ? owned.find(item => item.id === artifactId) : undefined
    if (artifactId && !destination) return
    const next = await api.captureExternalArtifact(artifactId
      ? { deliveryId, artifactId, expectedRevision: destination!.inputRevision }
      : { deliveryId, ...(title.trim() ? { title: title.trim() } : {}) })
    if (!current()) return
    setStandalone(items => [...items.filter(item => item.id !== next.id), next])
    setOpened(true)
    setNotice('已保存固定版本；未自动交接或启动报告助手。')
  })

  const openProgress = (assigneeId: string) => void run(async () => {
    const direct = await api.openDirect(assigneeId)
    if (!current()) return
    await useConversations.getState().reload()
    if (!current()) return
    useApp.getState().setView('conversations')
    useApp.getState().selectConversation(direct.id)
  })

  return <section className="mt-3 max-w-full border-t border-ink-100 pt-3 text-xs text-ink-600" aria-label="来源成果">
    <div className="flex flex-wrap items-center gap-2">
      {saved ? <>
        {handoffs.map(item => <button key={item.id} type="button" className={`${button} bg-sky2-50`} disabled={disabled} onClick={() => openProgress(item.assigneeId)}>已交给 {participants[item.assigneeId]?.name ?? item.assigneeId} · 查看进展</button>)}
        <button type="button" className={handoffs.length ? 'px-1 py-1.5 text-ink-500 underline underline-offset-2 disabled:opacity-50' : button} disabled={disabled || expired} onClick={() => setReader(saved.id)}>{handoffs.length ? '查看原始成果' : '查看成果'}</button>
        {expired && <span>临时成果已到期</span>}
      </> : !metadata && !opened ? <button type="button" className={button} onClick={() => setOpened(true)}>成果与交接</button>
        : <button type="button" className={button} disabled={disabled || captureExpired} onClick={() => capture()}>{busy ? '保存中…' : '保存成果'}</button>}
      {(loading || metadata?.loading) && <span role="status">正在读取成果…</span>}
    </div>
    {error && <p role="alert" className="mt-2 break-words text-coral-deep">{error}</p>}
    {metadata?.error && <p role="alert" className="mt-2">{metadata.error}</p>}
    {(error || metadata?.error) && <button type="button" className={`${button} mt-2`} disabled={busy || loading} onClick={() => { if (metadata) metadata.refresh(); else setRefresh(value => value + 1) }}>刷新成果</button>}
    {notice && <p role="status" className="mt-2">{notice}</p>}
    {captureExpired && <p role="status" className="mt-2">来源已到期，不能再保存；请从新的有效回答创建版本。</p>}
    {saved && !expired && !handoffs.length && <details className="mt-2" onToggle={event => { if (event.currentTarget.open) void useParticipants.getState().refresh() }}>
      <summary className="cursor-pointer font-semibold text-ink-700">交给报告助手</summary>
      <form className="mt-3 max-w-lg space-y-3 rounded-lg border border-ink-100 bg-sky2-50 p-3" onSubmit={event => {
        event.preventDefault()
        if (!source || source.stale || !receiver || !instructions.trim()) return
        const payload = JSON.stringify({ artifactId: saved.id, version: source.version, expectedRevision: saved.inputRevision, assigneeId: receiver, instructions })
        void run(async () => {
          if (!request.current || request.current.payload !== payload) request.current = { payload, id: crypto.randomUUID() }
          const handoff = await api.handoffExternalArtifact(saved.id, { version: source.version, expectedRevision: saved.inputRevision, assigneeId: receiver, instructions, requestId: request.current.id })
          if (!current()) return
          request.current = null
          setStandalone(items => items.map(item => item.id === saved.id ? { ...item, handoffs: [...item.handoffs.filter(existing => existing.id !== handoff.id), handoff] } : item))
          setInstructions('')
          setNotice('已创建待办，报告提交后仍需你明确审核。点击“查看进展”进入成员私聊。')
        })
      }}>
        <label className="block">接收成员<select className={control} value={receiver} onChange={event => setReceiver(event.target.value)} required disabled={disabled}>
          <option value="">选择启用的原生成员</option>{recipients.map(person => <option key={person.id} value={person.id}>{person.name}{person.role ? ` · ${person.role}` : ''}</option>)}
        </select></label>
        {!recipients.length && <p>没有可选的启用原生成员。请检查成员配置；外部服务成员不能接收交接。</p>}
        <label className="block">交接说明<textarea className={control} rows={2} value={instructions} onChange={event => setInstructions(event.target.value)} required disabled={disabled} /></label>
        <p>只分享来源 v{source?.version}，不授予知识库或原会话访问权限。使用既有原生执行配额；每个成果最多 3 次交接。</p>
        {source?.stale && <p>旧输入版本不能交接，请修订输入后显式保存新的来源回答。</p>}
        <button type="submit" className={`${button} bg-white`} disabled={disabled || !source || source.stale || !recipients.some(person => person.id === receiver) || !instructions.trim() || saved.handoffs.length >= 3}>确认交给所选成员</button>
      </form>
    </details>}
    {(metadata || opened) && <details className="mt-2"><summary className="cursor-pointer text-ink-500">来源版本操作</summary>
      <div className="mt-3 max-w-lg space-y-2">
        {!saved && <label className="block">成果标题（可选）<input className={control} value={title} onChange={event => setTitle(event.target.value)} disabled={disabled} /></label>}
        <p>仅原提问者可保存与交接。保存不会自动调用报告助手；修订输入和取消交接在成果阅读器的“技术详情”中。</p>
        <label className="block">将此回答保存到已有成果<select className={control} value={target} onChange={event => setTarget(event.target.value)} disabled={disabled}>
          <option value="">选择此会话的成果</option>{owned.map(item => <option key={item.id} value={item.id} disabled={item.expired || Date.parse(item.expiresAt) <= now}>{item.title} · 输入修订 {item.inputRevision}{item.expired ? ' · 已到期' : ''}</option>)}
        </select></label>
        <p>新回答必须与该成果当前输入原文匹配；服务器会校验所有者、生产者和修订号。</p>
        <button type="button" className={button} disabled={disabled || captureExpired || !target} onClick={() => capture(target)}>显式保存为新版本</button>
      </div>
    </details>}
    {reader && <ArtifactReader artifactId={reader} sourceDeliveryId={deliveryId} onClose={() => setReader(null)} />}
  </section>
}
