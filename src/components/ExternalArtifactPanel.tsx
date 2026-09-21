import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/api/client'
import { useAuth, useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import type { ArtifactContent, ArtifactHandoff, ArtifactSummary, ArtifactView } from '../../shared/external-artifacts'
import { RichBody } from './Message'

const control = 'w-full rounded border border-ink-200 bg-white p-2 text-ink-800 disabled:opacity-50'
const button = 'rounded border border-ink-200 px-3 py-1.5 text-ink-800 disabled:opacity-50'
const statuses: Record<ArtifactHandoff['status'], string> = {
  assigned: '待提交', submitted: '草稿待人工审核', accepted: '人工已接受', rejected: '人工已拒绝', cancelled: '已取消', stale: '输入已变更，交接失效',
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : '请求失败'
  if (error instanceof ApiError) {
    if (error.status === 403 || error.status === 404) return `${message}。仅原提问者可管理成果；请确认当前身份及原会话访问权限。`
    if (error.status === 409) return `${message}。请刷新成果，核对输入修订、固定版本及交接状态后重试。`
    if (error.status === 410) return `${message}。临时成果已到期，不会自动重新调用外部服务。`
  }
  return `${message}。请检查连接后重试；相同交接重试会沿用请求 ID。`
}

function useExpired(expiresAt?: string, expired = false) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!expiresAt) return
    const remaining = new Date(expiresAt).getTime() - Date.now()
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(remaining + 1, 2_147_483_647)))
    return () => window.clearTimeout(timer)
  }, [expiresAt])
  return expired || Boolean(expiresAt && new Date(expiresAt).getTime() <= now)
}

function Snapshot({ artifactId, version, expanded, expired, stale }: {
  artifactId: string; version: number; expanded: boolean; expired: boolean; stale: boolean
}) {
  const [content, setContent] = useState<ArtifactContent | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const contentExpired = useExpired(content?.expiresAt, expired)
  useEffect(() => {
    if (!expanded || expired) return
    let active = true
    setContent(null)
    setError('')
    api.getExternalArtifactVersion(artifactId, version).then(value => {
      if (active) setContent(value)
    }).catch(error => { if (active) setError(failure(error)) })
    return () => { active = false }
  }, [artifactId, version, expanded, expired, retry])
  if (contentExpired) return <p role="status">完整快照已到期，不可读取；已发布聊天正文仍按聊天记录保留。</p>
  if (error) return <div role="alert">{error} <button type="button" className={button} onClick={() => setRetry(value => value + 1)}>重试读取</button></div>
  if (!content) return <p role="status">正在读取固定版本…</p>
  return <div className="space-y-2">
    <p>版本 {content.version} · 输入修订 {content.inputRevision} · 生产者 {content.producerId}</p>
    <p className="whitespace-pre-wrap break-words">此版本的原始输入：{content.inputText}</p>
    <p>此版本到期时间：{new Date(content.expiresAt).toLocaleString()}</p>
    {(stale || content.stale) && <p role="status" className="font-semibold">旧输入版本（stale），仅供历史参考，不能作为当前输入交接或确认。</p>}
    <p className="break-all">SHA256：{content.sha256}</p>
    <p>固定于 {new Date(content.createdAt).toLocaleString()} · 来源交付 {content.sourceDeliveryId ?? '原生报告草稿'}</p>
    <details className="rounded border border-ink-100 bg-white p-3 text-sm">
      <summary className="cursor-pointer font-semibold">查看完整正文（{content.body.length} 字符）</summary>
      <div className="break-words" role="region" aria-label={`版本 ${content.version} 完整正文`}><RichBody body={content.body} external /></div>
    </details>
    <p>外部正文及继承引用均为不可信内容；引用关联不等于原规范或报告结论已获人工核准。</p>
    {content.limitations.map((limitation, index) => <div key={index}><RichBody body={limitation} external /></div>)}
    {content.citations.length === 0 && <p>没有可继承的检索引用。</p>}
    {content.citations.map(citation => <details key={citation.number} className="rounded border border-ink-100 p-2">
      <summary className="cursor-pointer">[{citation.number}] {citation.title}</summary>
      <RichBody body={citation.content} external />
      <p className="break-all">KB {citation.knowledgeBaseId} · 文档 {citation.knowledgeId} · chunk {citation.chunkId}
        {citation.chunkIndex !== undefined ? ` · 条块 ${citation.chunkIndex}` : ''} · {citation.level}</p>
    </details>)}
  </div>
}

function RevisionForm({ view, disabled, revise }: { view: ArtifactView; disabled: boolean; revise: (text: string) => void }) {
  const [text, setText] = useState(view.inputText)
  return <form className="space-y-2" onSubmit={event => { event.preventDefault(); revise(text) }}>
    <label className="block">修订输入（基于修订 {view.inputRevision}）
      <textarea className={control} rows={4} value={text} onChange={event => setText(event.target.value)} disabled={disabled} required />
    </label>
    <p>修订会使旧版本及未完成人工确认的交接失效，不会自动重新调用外部服务。请在原会话显式发送修订后的原文，再从匹配的新回答保存到此成果。</p>
    <button type="submit" className={button} disabled={disabled || !text.trim() || text === view.inputText}>保存输入修订</button>
  </form>
}

function HandoffReview({ handoff, view, expanded, disabled, review, cancel }: {
  handoff: ArtifactHandoff; view: ArtifactView; expanded: boolean; disabled: boolean
  review: (handoff: ArtifactHandoff, decision: 'accepted' | 'rejected', note: string) => void
  cancel: (handoff: ArtifactHandoff) => void
}) {
  const [note, setNote] = useState('')
  const recipient = useParticipants(state => state.byId[handoff.assigneeId])
  const expired = useExpired(view.expiresAt, view.expired)
  const output = view.versions.find(version => version.version === handoff.outputVersion)
  const live = handoff.status === 'assigned' || handoff.status === 'submitted'
  return <section className="space-y-2 rounded border border-ink-200 p-3" aria-label={`交接 ${handoff.id}`}>
    <p className="font-semibold">{recipient?.name ?? handoff.assigneeId} · {statuses[handoff.status]}</p>
    <p className="break-all">交接 {handoff.id} · 待办 {handoff.taskId} · 固定来源版本 {handoff.sourceVersion}</p>
    <p className="whitespace-pre-wrap break-words">交接说明：{handoff.instructions}</p>
    {handoff.outputVersion !== null && <>
      <h4 className="font-semibold">报告草稿 · 固定输出版本 {handoff.outputVersion}</h4>
      <Snapshot key={handoff.outputVersion} artifactId={view.id} version={handoff.outputVersion} expanded={expanded} expired={expired} stale={output?.stale ?? true} />
    </>}
    {handoff.reviewNote !== null && <p className="whitespace-pre-wrap break-words">人工审核备注：{handoff.reviewNote}</p>}
    {handoff.status === 'submitted' && <div className="space-y-2">
      <label className="block">人工审核备注（针对输出版本 {handoff.outputVersion}）
        <textarea className={control} value={note} rows={2} onChange={event => setNote(event.target.value)} disabled={disabled || expired || !output || output.stale} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={disabled || expired || !output || output.stale} onClick={() => review(handoff, 'accepted', note)}>接受此固定版本</button>
        <button type="button" className={button} disabled={disabled || expired || !output || output.stale} onClick={() => review(handoff, 'rejected', note)}>拒绝此固定版本</button>
      </div>
    </div>}
    {live && <button type="button" className={button} disabled={disabled || expired} onClick={() => cancel(handoff)}>取消交接并撤销成果访问</button>}
  </section>
}

function ArtifactPanelBody({ deliveryId, conversationId, expanded }: { deliveryId: string; conversationId: string; expanded: boolean }) {
  const me = useMe()
  const participants = useParticipants(state => state.byId)
  const recipients = Object.values(participants).filter(person => person.kind === 'agent' && person.executionKind === 'native' && person.executionEnabled === true && !person.departedAt)
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [view, setView] = useState<ArtifactView | null>(null)
  const [version, setVersion] = useState(0)
  const [title, setTitle] = useState('')
  const [receiver, setReceiver] = useState('')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [captureExpired, setCaptureExpired] = useState(false)
  const request = useRef<{ payload: string; id: string } | null>(null)
  const selected = artifacts.find(artifact => artifact.id === selectedId)
  const expired = useExpired(view?.expiresAt ?? selected?.expiresAt, view?.expired ?? selected?.expired)
  const owned = artifacts.filter(artifact => artifact.ownerId === me && artifact.sourceConversationId === conversationId)
  const pending = Boolean(view?.handoffs.some(handoff => handoff.status === 'assigned' || handoff.status === 'submitted'))
  const currentVersion = view?.versions.find(item => item.version === version)
  const disabled = busy || loading || expired || view?.ownerId !== me

  const update = useCallback((next: ArtifactView) => {
    setView(next)
    setArtifacts(items => [...items.filter(item => item.id !== next.id), next])
    setVersion(current => next.versions.some(item => item.version === current) ? current : next.latestVersion)
  }, [])

  useEffect(() => {
    if (!expanded) return
    let active = true
    api.listExternalArtifacts().then(result => {
      if (active) setArtifacts(result.artifacts)
    }).catch(error => { if (active) setError(failure(error)) })
    return () => { active = false }
  }, [expanded, refresh])

  useEffect(() => {
    if (!expanded || !selectedId || busy) return
    let active = true
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      setLoading(true)
      try {
        const next = await api.getExternalArtifact(selectedId)
        if (active) update(next)
      } catch (error) {
        if (active) { setError(failure(error)); setView(null) }
      } finally {
        inFlight = false
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = pending && !expired ? window.setInterval(() => { void load() }, 5000) : undefined
    return () => { active = false; window.clearInterval(timer) }
  }, [expanded, selectedId, busy, refresh, pending, expired, update])

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try { await action() } catch (error) { setError(failure(error)) }
    finally { setBusy(false) }
  }

  const payload = view ? JSON.stringify({ artifactId: view.id, version, expectedRevision: view.inputRevision, assigneeId: receiver, instructions }) : ''

  return <div className="mt-3 space-y-4">
    <p>仅原问题的人类提问者可以保存、交接和审核。选择接收者仅分享固定成果，不授予知识库或原会话访问权限。</p>
    <button type="button" className={button} disabled={busy || loading} onClick={() => {
      setError(''); setRefresh(value => value + 1); void useParticipants.getState().refresh()
    }}>刷新成果与交接</button>
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-coral-deep">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <form className="space-y-2" onSubmit={event => {
      event.preventDefault()
      void run(async () => {
        const saved = await api.captureExternalArtifact(selectedId
          ? { deliveryId, artifactId: selectedId, expectedRevision: selected?.inputRevision }
          : { deliveryId, ...(title.trim() ? { title: title.trim() } : {}) }).catch(error => {
          if (error instanceof ApiError && error.status === 410) setCaptureExpired(true)
          throw error
        })
        update(saved)
        setSelectedId(saved.id)
        setVersion(saved.latestVersion)
        setNotice('完整回答已保存为固定版本；未自动发起交接。')
      })
    }}>
      <label className="block">保存目标 / 查看已有成果
        <select className={control} value={selectedId} disabled={busy} onChange={event => {
          setSelectedId(event.target.value); setView(null); setVersion(0); setLoading(false); setError(''); setNotice('')
        }}>
          <option value="">新建成果</option>
          {owned.map(artifact => <option key={artifact.id} value={artifact.id}>{artifact.title} · {artifact.id} · 输入修订 {artifact.inputRevision}{artifact.expired ? ' · 已到期' : ''}</option>)}
        </select>
      </label>
      {!selectedId && <label className="block">新成果标题（可选）<input className={control} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} /></label>}
      {selectedId && <p>仅列出你在此会话拥有的成果。新回答必须对应成果当前输入的完整原文；服务器还会校验所有者、生产者及修订号。</p>}
      {captureExpired && <p role="status">此来源的临时内容已到期，不能再保存；请从原会话中新的有效回答创建版本。</p>}
      <button type="submit" className={button} disabled={busy || loading || captureExpired || Boolean(selectedId && (!selected || expired))}>{busy ? '提交中…' : selectedId ? '将此回答保存为该成果的新版本' : '保存此完整回答为新成果'}</button>
    </form>
    {loading && <p role="status">正在刷新成果…</p>}
    {view && <section className="space-y-4" aria-label="固定成果与人工交接">
      <div>
        <h3 className="font-semibold">{view.title}</h3>
        <p className="break-all">成果 ID：{view.id}</p>
        <p>输入修订 {view.inputRevision} · 到期时间 {new Date(view.expiresAt).toLocaleString()}{expired ? ' · 已到期' : ''}</p>
        <p>到期时间沿用原调用，保存、交接不会延长；到期后只保留最小身份账本。</p>
        <p className="whitespace-pre-wrap break-words">当前输入：{view.inputText}</p>
      </div>
      <label className="block">查看固定版本
        <select className={control} value={version} disabled={busy} onChange={event => setVersion(Number(event.target.value))}>
          {view.versions.map(item => <option key={item.version} value={item.version}>版本 {item.version} · 输入修订 {item.inputRevision}{item.stale ? ' · stale / 旧输入' : ''}</option>)}
        </select>
      </label>
      {currentVersion && <Snapshot key={`${view.id}:${version}`} artifactId={view.id} version={version} expanded={expanded} expired={expired} stale={currentVersion.stale} />}
      <RevisionForm key={`${view.id}:${view.inputRevision}`} view={view} disabled={disabled} revise={inputText => {
        void run(async () => {
          update(await api.reviseExternalArtifact(view.id, { expectedRevision: view.inputRevision, inputText }))
          setNotice('输入已修订。请在原会话显式发送新输入；旧版本保留但已标记 stale。')
        })
      }} />
      <form className="space-y-2 rounded border border-ink-200 p-3" onSubmit={event => {
        event.preventDefault()
        void run(async () => {
          if (!request.current || request.current.payload !== payload) request.current = { payload, id: crypto.randomUUID() }
          const handoff = await api.handoffExternalArtifact(view.id, {
            version, expectedRevision: view.inputRevision, assigneeId: receiver, instructions, requestId: request.current.id,
          })
          update({ ...view, handoffs: [...view.handoffs.filter(item => item.id !== handoff.id), handoff] })
          request.current = null
          setInstructions('')
          setNotice(`已交接固定版本 ${handoff.sourceVersion}；待办 ${handoff.taskId} 已保存。是否执行及提交以交接状态为准。`)
        })
      }}>
        <h4 className="font-semibold">显式交给原生报告助手 · 固定版本 {version}</h4>
        <label className="block">接收成员
          <select className={control} value={receiver} onChange={event => setReceiver(event.target.value)} disabled={disabled} required>
            <option value="">选择启用的原生成员</option>
            {recipients.map(person => <option key={person.id} value={person.id}>{person.name}{person.role ? ` · ${person.role}` : ''}</option>)}
          </select>
        </label>
        {recipients.length === 0 && <p>当前没有可选的启用原生成员。请检查成员配置后刷新；外部服务成员不能接收此交接。</p>}
        <label className="block">交接说明
          <textarea className={control} rows={3} value={instructions} onChange={event => setInstructions(event.target.value)} disabled={disabled} required />
        </label>
        <p>每个成果最多 3 次交接，采用既有原生执行配额，不是金额硬预算。提交仅生成待人工审核草稿，不能继续委派。</p>
        <button type="submit" className={button} disabled={disabled || !currentVersion || currentVersion.stale || currentVersion.sourceDeliveryId === null || !recipients.some(person => person.id === receiver) || !instructions.trim() || view.handoffs.length >= 3}>确认分享固定版本并创建待办</button>
        {currentVersion?.sourceDeliveryId === null && <p>报告草稿不能继续委派。请选择外部回答的固定版本作为交接来源。</p>}
      </form>
      <p>取消交接仅撤销成果访问与晚到提交资格，不保证中断已启动的原生模型。远端 stop / resume / input-required 尚未接入；未知外部请求不会自动重投。</p>
      <h4 className="font-semibold">交接与人工审核（{view.handoffs.length}/3）</h4>
      {view.handoffs.length === 0 && <p>尚无交接。保存版本不会自动启动报告助手。</p>}
      {view.handoffs.map(handoff => <HandoffReview key={handoff.id} handoff={handoff} view={view} expanded={expanded} disabled={disabled}
        review={(item, decision, note) => {
          if (item.outputVersion === null) return
          const outputVersion = item.outputVersion
          void run(async () => {
            update(await api.reviewExternalArtifact(view.id, item.id, { outputVersion, decision, note }))
            setNotice(`已${decision === 'accepted' ? '接受' : '拒绝'}固定输出版本 ${outputVersion}。`)
          })
        }}
        cancel={item => { void run(async () => {
          update(await api.cancelExternalArtifactHandoff(view.id, item.id))
          setNotice('交接已取消，成果访问与后续提交权限已撤销；未声称中断模型。')
        }) }}
      />)}
    </section>}
  </div>
}

export function ExternalArtifactPanel({ deliveryId, conversationId }: { deliveryId: string; conversationId: string }) {
  const companyId = useAuth(state => state.activeCompanyId)
  const me = useMe()
  const [expanded, setExpanded] = useState(false)
  const [opened, setOpened] = useState(false)
  return <details className="mt-3 max-w-full rounded border border-ink-200 bg-sky2-50 p-3 text-xs text-ink-700" onToggle={event => {
    setExpanded(event.currentTarget.open)
    if (event.currentTarget.open) setOpened(true)
  }}>
    <summary className="cursor-pointer font-semibold">成果与交接 · 保存完整版本 / 原生报告 / 人工审核</summary>
    {opened && <ArtifactPanelBody key={`${companyId}:${me}:${deliveryId}`} deliveryId={deliveryId} conversationId={conversationId} expanded={expanded} />}
  </details>
}
