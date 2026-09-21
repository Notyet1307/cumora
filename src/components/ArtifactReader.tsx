import { useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError } from '@/api/client'
import { useApp } from '@/stores/app'
import { useAuth, useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import type { ArtifactContent, ArtifactHandoff, ArtifactView } from '../../shared/external-artifacts'
import { ArtifactConversationContext, ARTIFACTS_CHANGED } from './ArtifactConversation'
import { RichBody } from './Message'

const control = 'w-full rounded-lg border border-ink-200 bg-white p-2 text-ink-800 disabled:opacity-50'
const button = 'rounded-lg border border-ink-200 px-3 py-2 text-sm font-semibold text-ink-800 disabled:opacity-50'
const statuses: Record<ArtifactHandoff['status'], string> = {
  assigned: '等待提交', submitted: '草稿 · 待人工审核', accepted: '人工已采用', rejected: '人工不采用', cancelled: '已取消', stale: '输入已变更 · 交接失效',
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    if ([403, 404].includes(error.status)) return '成果访问已撤销或当前身份无权读取。请确认原会话访问权限。'
    if (error.status === 410) return '临时成果已到期，完整正文不可读取。不会自动重新调用外部服务。'
    if (error.status === 409) return '输入或交接状态已变更，请刷新后核对固定版本。'
  }
  return error instanceof Error ? error.message : '请求失败，请重试。'
}

export function ArtifactReader({ artifactId, handoffId, sourceDeliveryId, onClose }: {
  artifactId: string; handoffId?: string; sourceDeliveryId?: string; onClose: () => void
}) {
  const epoch = useAuth(state => state.contextEpoch)
  const conversationId = useApp(state => state.selectedConversationId)
  const scope = useRef({ epoch, conversationId })
  const changed = epoch !== scope.current.epoch || conversationId !== scope.current.conversationId
  useEffect(() => { if (changed) onClose() }, [changed, onClose])
  if (changed) return null
  return <Reader key={`${epoch}:${conversationId}:${artifactId}:${handoffId ?? ''}:${sourceDeliveryId ?? ''}`} artifactId={artifactId} handoffId={handoffId} sourceDeliveryId={sourceDeliveryId} onClose={onClose} />
}

function Reader({ artifactId, handoffId, sourceDeliveryId, onClose }: {
  artifactId: string; handoffId?: string; sourceDeliveryId?: string; onClose: () => void
}) {
  const metadata = useContext(ArtifactConversationContext)
  const me = useMe()
  const epoch = useAuth(state => state.contextEpoch)
  const conversationId = useApp(state => state.selectedConversationId)
  const participants = useParticipants(state => state.byId)
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const mounted = useRef(false)
  const sequence = useRef(0)
  const mutation = useRef(false)
  const [view, setView] = useState<ArtifactView | null>(null)
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [selection, setSelection] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState(false)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now)
  const [note, setNote] = useState('')
  const [input, setInput] = useState('')
  const current = () => mounted.current && useAuth.getState().contextEpoch === epoch && useApp.getState().selectedConversationId === conversationId
  const listed = metadata?.artifacts.find(item => item.id === artifactId)
  const denied = blocked || Boolean(metadata && (metadata.error || (!metadata.loading && !listed) || (listed && listed.ownerId !== me)))
  const expiresAt = listed?.expiresAt ?? view?.expiresAt
  const expired = Boolean(listed?.expired || view?.expired || (expiresAt && Date.parse(expiresAt) <= now))
  const handoff = view?.handoffs.find(item => item.id === handoffId)
  const pending = Boolean(view?.handoffs.some(item => item.status === 'assigned' || item.status === 'submitted'))
  const version = handoffId ? handoff?.outputVersion ?? handoff?.sourceVersion
    : selection ?? (sourceDeliveryId ? view?.versions.find(item => item.sourceDeliveryId === sourceDeliveryId)?.version
      : view?.versions.reduce((latest, item) => item.sourceDeliveryId !== null ? Math.max(latest, item.version) : latest, 0))
  const versionMetadata = view?.versions.find(item => item.version === version)
  const listedVersion = listed?.versions.find(item => item.version === version)
  const listedHandoff = listed?.handoffs.find(item => item.id === handoffId)
  const readable = !denied && !expired && view?.ownerId === me && (!handoffId || Boolean(handoff))
    && (!metadata || Boolean(listedVersion && (!handoffId || listedHandoff)))
  const body = readable && content?.version === version ? content : null
  const stale = Boolean(versionMetadata?.stale || listedVersion?.stale || body?.stale)
  const reviewable = Boolean(body && handoff?.status === 'submitted' && handoff.outputVersion === body.version && !stale
    && (!metadata || (listedHandoff?.status === 'submitted' && listedHandoff.outputVersion === body.version)))

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = dialog.current
    node?.showModal()
    closeButton.current?.focus()
    return () => {
      mounted.current = false
      sequence.current++
      node?.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (!expiresAt) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(Date.parse(expiresAt) - Date.now() + 1, 2_147_483_647)))
    return () => window.clearTimeout(timer)
  }, [expiresAt])

  useEffect(() => {
    if (denied || expired) {
      sequence.current++
      setContent(null)
      if (denied) setView(null)
      setLoading(false)
    }
  }, [denied, expired])

  useEffect(() => {
    const reload = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === artifactId) {
        sequence.current++
        setBlocked(true)
        setLoading(false)
        setContent(null)
        setView(null)
      }
      setRefresh(value => value + 1)
    }
    window.addEventListener('focus', reload)
    window.addEventListener(ARTIFACTS_CHANGED, reload)
    const timer = pending && !expired ? window.setInterval(() => setRefresh(value => value + 1), 5000) : undefined
    return () => {
      window.removeEventListener('focus', reload)
      window.removeEventListener(ARTIFACTS_CHANGED, reload)
      window.clearInterval(timer)
    }
  }, [artifactId, pending, expired])

  useEffect(() => {
    if (denied || expired || busy) return
    let active = true
    const request = ++sequence.current
    const valid = () => active && mounted.current && sequence.current === request && useAuth.getState().contextEpoch === epoch && useApp.getState().selectedConversationId === conversationId
    setLoading(true)
    const load = async () => {
      try {
        const next = await api.getExternalArtifact(artifactId)
        if (!valid()) return
        if (next.ownerId !== me) throw new ApiError('Forbidden', 403)
        if (next.expired || Date.parse(next.expiresAt) <= Date.now()) throw new ApiError('Expired', 410)
        const fixed = handoffId ? next.handoffs.find(item => item.id === handoffId) : undefined
        if (handoffId && !fixed) throw new ApiError('Handoff unavailable', 403)
        // A delivery always follows its own fixed output, never latestVersion.
        const chosen = fixed ? fixed.outputVersion ?? fixed.sourceVersion
          : selection ?? (sourceDeliveryId ? next.versions.find(item => item.sourceDeliveryId === sourceDeliveryId)?.version
            : next.versions.reduce((latest, item) => item.sourceDeliveryId !== null ? Math.max(latest, item.version) : latest, 0))
        if (chosen === undefined || !next.versions.some(item => item.version === chosen)) throw new ApiError('Version unavailable', 404)
        setView(next)
        // Metadata refresh reauthorizes access; immutable snapshots need not be downloaded on every poll.
        const snapshot = content?.version === chosen && content.sha256 === next.versions.find(item => item.version === chosen)?.sha256
          ? content : await api.getExternalArtifactVersion(artifactId, chosen)
        if (!valid()) return
        if (snapshot.artifactId !== artifactId || snapshot.version !== chosen) throw new Error('固定版本不匹配，请重新读取。')
        if (Date.parse(snapshot.expiresAt) <= Date.now()) throw new ApiError('Expired', 410)
        setContent(snapshot)
        setError('')
      } catch (err) {
        if (!valid()) return
        setContent(null)
        setView(null)
        setError(failure(err))
        if (err instanceof ApiError && [403, 404, 410].includes(err.status)) {
          // Invalidate shared metadata without repeatedly refetching a denied body.
          setBlocked(true)
          setLoading(false)
          active = false
          window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: artifactId }))
        }
      } finally {
        if (active && valid()) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [artifactId, handoffId, sourceDeliveryId, selection, refresh, denied, expired, busy, epoch, conversationId, me])

  const run = async (action: () => Promise<ArtifactView>) => {
    if (mutation.current || !current() || !readable || loading) return
    mutation.current = true
    sequence.current++
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const next = await action()
      if (!current()) return
      setView(next)
      setContent(null)
      setNote('')
      setNotice('已保存。人工决定仅针对所选固定版本。')
    } catch (err) {
      if (!current()) return
      setError(failure(err))
      setContent(null)
      if (err instanceof ApiError && [403, 404, 410].includes(err.status)) {
        setView(null)
        window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED, { detail: artifactId }))
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

  return createPortal(<dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, summary, [tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
      const target = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
        : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined
      if (target) { event.preventDefault(); target.focus() }
    }}
    className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-none border-0 bg-paper p-0 text-ink-800 shadow-2xl backdrop:bg-ink-900/30 md:max-w-[720px]"
    style={{ background: 'var(--chrome-warm)' }}>
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
        <div className="min-w-0"><h2 id={titleId} className="break-words text-lg font-semibold">{readable ? view?.title ?? '成果报告' : '成果报告'}</h2>
          <p className="mt-1 text-xs text-ink-500">{expired ? '已到期' : handoff ? statuses[handoff.status] : '来源回答 · 固定版本'}{version ? ` · v${version}` : ''}</p>
        </div>
        <button ref={closeButton} type="button" className={button} onClick={onClose} aria-label="关闭报告">关闭</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 md:px-8">
        <p className="mb-4 text-xs text-ink-500">不可信草稿与引用，仅供核对；提交不代表人工采用或正式发布。</p>
        {(denied || expired) && <p role="alert">{expired ? '临时成果已到期，完整正文不可读取；不会自动重新调用外部服务。' : '成果访问已撤销或当前身份无权读取。'}</p>}
        {error && <p role="alert" className="mb-3 break-words text-sm text-coral-deep">{error}</p>}
        {notice && <p role="status" className="mb-3 text-sm">{notice}</p>}
        {loading && !body && !denied && !expired && <p role="status">正在读取固定版本…</p>}
        {!denied && !expired && !body && !loading && <button type="button" className={button} onClick={() => { metadata?.refresh(); setRefresh(value => value + 1) }}>重新读取</button>}
        {body && <>
          {stale && <p role="status" className="mb-4 rounded-lg bg-sky2-50 p-3 text-sm">旧输入版本，仅供历史参考，不能作为当前输入交接或确认。</p>}
          <article aria-label={`版本 ${body.version} 报告正文`} className="break-words text-[15px] leading-7"><RichBody body={body.body} external /></article>
          <details className="mt-8 border-t border-ink-200 pt-4 text-sm">
            <summary className="cursor-pointer font-semibold">来源与版本</summary>
            <div className="mt-4 space-y-4">
              {!handoffId && <label className="block">固定版本<select className={`${control} mt-1`} value={version ?? ''} disabled={busy || loading} onChange={event => { sequence.current++; setContent(null); setSelection(Number(event.target.value)); setNote('') }}>
                {view?.versions.map(item => <option key={item.version} value={item.version}>v{item.version} · {item.sourceDeliveryId ? '来源回答' : '报告草稿'} · 输入修订 {item.inputRevision}{item.stale ? ' · 旧输入' : ''}</option>)}
              </select></label>}
              {handoff && <p>此交付固定为 v{body.version}，来源为 v{handoff.sourceVersion}；不会切换到其他交接的报告。</p>}
              <p className="whitespace-pre-wrap break-words">原始输入（修订 {body.inputRevision}）：{body.inputText}</p>
              {handoff && <p className="whitespace-pre-wrap break-words">交给 {participants[handoff.assigneeId]?.name ?? handoff.assigneeId}：{handoff.instructions}</p>}
              <p>到期：{new Date(body.expiresAt).toLocaleString()}。保存与交接不会延长保留时间。</p>
              <div className="space-y-2"><h3 className="font-semibold">检索引用</h3>{!body.citations.length && <p className="text-ink-500">没有可继承的检索引用。</p>}
                {body.citations.map(citation => <details key={citation.number} className="rounded-lg border border-ink-100 p-3"><summary className="cursor-pointer">[{citation.number}] {citation.title}</summary>
                  <div className="mt-2 break-words"><RichBody body={citation.content} external /></div>
                  <p className="mt-2 break-all text-xs text-ink-500">KB {citation.knowledgeBaseId} · 文档 {citation.knowledgeId} · chunk {citation.chunkId}{citation.chunkIndex !== undefined ? ` · 条块 ${citation.chunkIndex}` : ''} · {citation.level}</p>
                </details>)}
              </div>
            </div>
          </details>
          <details className="mt-4 border-t border-ink-200 pt-4 text-sm"><summary className="cursor-pointer font-semibold">技术详情</summary>
            <div className="mt-4 space-y-3 break-words">
              <p>成果 {artifactId} · 生产者 {body.producerId} · 固定于 {new Date(body.createdAt).toLocaleString()}</p>
              <p className="break-all">SHA256：{body.sha256}</p><p>来源交付：{body.sourceDeliveryId ?? '原生报告草稿'}</p>
              {body.limitations.map((limitation, index) => <RichBody key={index} body={limitation} external />)}
              {view?.handoffs.map(item => <div key={item.id} className="space-y-1 border-t border-ink-100 pt-3"><p>{participants[item.assigneeId]?.name ?? item.assigneeId} · {statuses[item.status]} · 来源 v{item.sourceVersion}{item.outputVersion !== null ? ` → 输出 v${item.outputVersion}` : ''}</p>
                <p className="break-all text-xs text-ink-500">交接 {item.id} · 待办 {item.taskId}</p>
                {item.reviewNote !== null && <p className="whitespace-pre-wrap">人工备注：{item.reviewNote || '无'}</p>}
                {(item.status === 'assigned' || item.status === 'submitted') && <button type="button" className={button} disabled={busy || loading} onClick={() => void run(() => api.cancelExternalArtifactHandoff(artifactId, item.id))}>取消交接并撤销成果访问</button>}
              </div>)}
              <p className="text-xs text-ink-500">取消撤销访问及晚到提交资格，不保证中断已启动的模型。未知请求不会自动重投；远端 stop / resume / input-required 尚未接入。</p>
              {!handoffId && <details><summary className="cursor-pointer">修订来源输入</summary><form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); if (view) void run(() => api.reviseExternalArtifact(artifactId, { expectedRevision: view.inputRevision, inputText: input })) }}>
                <label className="block">新输入原文<textarea className={control} rows={3} value={input} onChange={event => setInput(event.target.value)} required disabled={busy || loading} /></label>
                <p>修订使旧版本及未完成人工确认的交接失效，不会自动调用服务。请在原会话显式发送新原文，再从匹配的新回答保存新版本。</p>
                <button type="submit" className={button} disabled={busy || loading || !input.trim() || input === view?.inputText}>保存输入修订</button>
              </form></details>}
            </div>
          </details>
        </>}
      </div>
      {readable && handoff && <footer className="shrink-0 space-y-2 border-t border-ink-200 bg-paper px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {handoff.status === 'submitted' ? <>
          <label className="block text-xs text-ink-500">人工审核备注（可选）<textarea rows={1} className={`${control} mt-1`} value={note} onChange={event => setNote(event.target.value)} disabled={!reviewable || busy || loading} /></label>
          <div className="flex flex-wrap items-center gap-2"><button type="button" className={`${button} bg-sky2-50`} disabled={!reviewable || busy || loading} onClick={() => { if (reviewable && handoff.outputVersion !== null) void run(() => api.reviewExternalArtifact(artifactId, handoff.id, { outputVersion: handoff.outputVersion!, decision: 'accepted', note })) }}>确认采用</button>
            <button type="button" className={button} disabled={!reviewable || busy || loading} onClick={() => { if (reviewable && handoff.outputVersion !== null) void run(() => api.reviewExternalArtifact(artifactId, handoff.id, { outputVersion: handoff.outputVersion!, decision: 'rejected', note })) }}>不采用</button>
            <span className="text-xs text-ink-500">仅针对 v{handoff.outputVersion}，不自动发布</span></div>
        </> : <><p className="text-sm font-semibold">{statuses[handoff.status]}</p>{handoff.reviewNote !== null && <p className="whitespace-pre-wrap break-words text-sm">人工备注：{handoff.reviewNote || '无'}</p>}</>}
      </footer>}
    </div>
  </dialog>, document.body)
}
