import { Component, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { api, ApiError } from '@/api/client'
import { useAuth, useMe } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { VIRTUOSO_FIRST_INDEX_BASE } from '@/stores/messages'
import { artifactAssignee, timelineFirstIndex, type ArtifactTimelineEvent, type ConversationTimelineItem } from '@/lib/artifactTimeline'
import type { ArtifactHandoff, ArtifactView } from '../../shared/external-artifacts'

export const ARTIFACTS_CHANGED = 'cumora:artifacts-changed'
export const ArtifactConversationContext = createContext<{
  artifacts: ArtifactView[]
  loading: boolean
  error: string
  refresh: () => void
} | null>(null)

const statuses: Record<ArtifactHandoff['status'], string> = {
  assigned: '待提交', submitted: '待人工审核', accepted: '人工已接受', rejected: '人工已拒绝', cancelled: '已取消', stale: '输入已变更，交接失效',
}
const emptyArtifacts: ArtifactView[] = []

/** One authorized metadata request per conversation/auth scope, shared by source links and timeline. */
export function useArtifactConversation(conversationId: string | null) {
  const ownerId = useMe()
  const epoch = useAuth(state => state.contextEpoch)
  const conversation = useConversations(state => state.list.find(item => item.id === conversationId))
  const participants = useParticipants(state => state.byId)
  const assigneeId = artifactAssignee(conversation, ownerId, participants)
  const allowed = Boolean(ownerId && conversation?.members.includes(ownerId))
  const scope = JSON.stringify([epoch, conversationId, ownerId, allowed, assigneeId])
  const [state, setState] = useState({ scope, artifacts: emptyArtifacts, loading: false, error: '' })
  const reload = useRef<() => void>(() => {})
  const refresh = useCallback(() => reload.current(), [])

  useEffect(() => {
    let active = true
    let generation = 0
    let inFlight = false
    let queued = false
    let visible: ArtifactView[] = []
    setState({ scope, artifacts: emptyArtifacts, loading: allowed, error: '' })
    if (!allowed) return
    const current = () => active && useAuth.getState().contextEpoch === epoch
    const load = async () => {
      if (!current()) return
      if (inFlight) { queued = true; return }
      inFlight = true
      const request = ++generation
      setState(value => ({ ...value, loading: true }))
      try {
        const result = await api.listExternalArtifacts()
        if (!current() || request !== generation) return
        visible = result.artifacts.filter(artifact => artifact.ownerId === ownerId && (
          artifact.sourceConversationId === conversationId
          || Boolean(assigneeId && artifact.handoffs.some(handoff => handoff.assigneeId === assigneeId))
        ))
        setState({ scope, artifacts: visible, loading: false, error: '' })
      } catch (error) {
        if (!current() || request !== generation) return
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) visible = []
        setState({ scope, artifacts: visible, loading: false, error: '成果记录暂不可读取，请确认原会话权限后重试。' })
      } finally {
        inFlight = false
        if (current() && queued) { queued = false; void load() }
      }
    }
    const changed = (event: Event) => {
      generation++
      // A reader can revoke one cached item immediately, before its refresh ends.
      const artifactId: unknown = event instanceof CustomEvent ? event.detail : undefined
      if (typeof artifactId === 'string') {
        visible = visible.filter(artifact => artifact.id !== artifactId)
        setState(value => ({ ...value, artifacts: visible }))
      }
      void load()
    }
    const onFocus = () => { void load() }
    reload.current = onFocus
    window.addEventListener('focus', onFocus)
    window.addEventListener(ARTIFACTS_CHANGED, changed)
    void load()
    const timer = window.setInterval(() => {
      if (visible.some(artifact => !artifact.expired && Date.parse(artifact.expiresAt) > Date.now()
        && artifact.handoffs.some(handoff => (!assigneeId || handoff.assigneeId === assigneeId)
          && (handoff.status === 'assigned' || handoff.status === 'submitted')))) void load()
    }, 5000)
    return () => {
      active = false
      reload.current = () => {}
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener(ARTIFACTS_CHANGED, changed)
    }
  }, [scope, epoch, allowed, ownerId, conversationId, assigneeId])

  // Hide old-scope data during render, not one effect later.
  const context = useMemo(() => ({
    artifacts: state.scope === scope ? state.artifacts : emptyArtifacts,
    loading: state.scope === scope ? state.loading : allowed,
    error: state.scope === scope ? state.error : '',
    refresh,
  }), [state, scope, allowed, refresh])
  return { context, scope, ownerId, assigneeId }
}

export function ArtifactStreamStatus() {
  const context = useContext(ArtifactConversationContext)
  if (!context) return null
  if (context.error) return <div role="alert" className="text-xs text-ink-500 text-center">
    {context.error} <button type="button" className="underline" disabled={context.loading} onClick={context.refresh}>重试</button>
  </div>
  if (!context.artifacts.length) return context.loading
    ? <p role="status" className="text-xs text-ink-400 text-center">正在读取成果记录…</p> : null
  return <button type="button" className="self-center text-[11px] text-ink-400 hover:text-skype-deep disabled:opacity-50" disabled={context.loading} onClick={context.refresh}>
    {context.loading ? '正在刷新成果记录…' : '刷新成果记录'}
  </button>
}

export function ArtifactTimelineCard({ event, onOpen }: {
  event: ArtifactTimelineEvent
  onOpen: (artifactId: string, handoffId: string) => void
}) {
  const recipient = useParticipants(state => state.byId[event.handoff.assigneeId]?.name?.trim() || '原生成员')
  const expired = event.artifact.expired || Date.parse(event.artifact.expiresAt) <= Date.now()
  return <div data-timeline-key={event.key} className="px-3 py-2 md:px-6 md:py-[9px]">
    <article aria-label={event.kind === 'report' ? '成果交付' : '交接记录'} className="max-w-[620px] rounded-2xl border border-ink-100 bg-paper/90 p-4 text-sm text-ink-700 shadow-sm">
      <div className="flex items-center justify-between gap-3 text-[11px] text-ink-400">
        <span className="font-semibold text-skype-deep">{event.kind === 'report' ? '成果交付' : '交接记录'}</span>
        <time dateTime={event.at}>{new Date(event.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      </div>
      <h3 className="mt-2 break-words font-semibold text-ink-900">{event.artifact.title}</h3>
      <p className="mt-1 text-xs">{recipient} · {statuses[event.handoff.status]}</p>
      {event.kind === 'handoff' && event.handoff.instructions && <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-xs text-ink-500">{event.handoff.instructions}</p>}
      {expired && <p className="mt-2 text-xs text-ink-400">快照已到期，交接记录保留</p>}
      {event.kind === 'report' && <button type="button" onClick={() => onOpen(event.artifact.id, event.handoff.id)} className="mt-3 rounded-lg border border-sky2-200 bg-sky2-50 px-3 py-1.5 text-xs font-semibold text-skype-deep hover:bg-sky2-100 focus-visible:outline-2 focus-visible:outline-skype-deep">查看报告</button>}
    </article>
  </div>
}

export function useTimelineFirstIndex(items: ConversationTimelineItem[], scope: string) {
  const [previous, setPrevious] = useState({ items, scope, index: VIRTUOSO_FIRST_INDEX_BASE })
  if (previous.items === items && previous.scope === scope) return previous.index
  const index = previous.scope === scope ? timelineFirstIndex(previous.items, items, previous.index) : VIRTUOSO_FIRST_INDEX_BASE
  setPrevious({ items, scope, index })
  return index
}

type AnchorProps = {
  items: ConversationTimelineItem[]
  scope: string
  atBottom: boolean
  streamRef: RefObject<HTMLDivElement | null>
  virtuosoRef: RefObject<VirtuosoHandle | null>
  children: ReactNode
}
type AnchorSnapshot = { key: string; offset: number }

/** Snapshot BEFORE DOM mutations; firstItemIndex alone cannot anchor interior metadata insertions. */
export class ArtifactTimelineAnchor extends Component<AnchorProps, Record<string, never>, AnchorSnapshot | null> {
  private frame = 0

  getSnapshotBeforeUpdate(previous: AnchorProps): AnchorSnapshot | null {
    if (previous.scope !== this.props.scope || previous.atBottom || previous.items === this.props.items) return null
    // Virtuoso already anchors prepends through firstItemIndex; don't adjust that scroll twice.
    if (previous.items[0]?.key !== this.props.items[0]?.key) return null
    const changed = previous.items.length !== this.props.items.length || previous.items.some((item, index) => {
      const next = this.props.items[index]
      if (item.key !== next?.key) return true
      if (item.kind === 'message' || next?.kind === 'message') return false
      return item.artifact.title !== next.artifact.title
        || item.artifact.expired !== next.artifact.expired
        || item.artifact.expiresAt !== next.artifact.expiresAt
        || item.handoff.status !== next.handoff.status
        || item.handoff.instructions !== next.handoff.instructions
    })
    const stream = this.props.streamRef.current
    if (!changed || !stream) return null
    const top = stream.getBoundingClientRect().top
    const keys = new Set(this.props.items.map(item => item.key))
    for (const row of stream.querySelectorAll<HTMLElement>('[data-timeline-key]')) {
      if (keys.has(row.dataset.timelineKey!) && row.getBoundingClientRect().bottom > top) {
        return { key: row.dataset.timelineKey!, offset: row.getBoundingClientRect().top - top }
      }
    }
    return null
  }

  componentDidUpdate(_previous: AnchorProps, _state: Record<string, never>, snapshot: AnchorSnapshot | null) {
    if (!snapshot) return
    cancelAnimationFrame(this.frame)
    const scope = this.props.scope
    const restore = (retry: boolean) => {
      if (this.props.scope !== scope) return
      const stream = this.props.streamRef.current
      if (!stream) return
      const row = Array.from(stream.querySelectorAll<HTMLElement>('[data-timeline-key]')).find(item => item.dataset.timelineKey === snapshot.key)
      if (row) {
        const delta = row.getBoundingClientRect().top - stream.getBoundingClientRect().top - snapshot.offset
        if (Math.abs(delta) > 1) this.props.virtuosoRef.current?.scrollBy({ top: delta, behavior: 'auto' })
      } else {
        const index = this.props.items.findIndex(item => item.key === snapshot.key)
        if (index >= 0) this.props.virtuosoRef.current?.scrollToIndex({ index, align: 'start', offset: -snapshot.offset, behavior: 'auto' })
      }
      if (retry) this.frame = requestAnimationFrame(() => restore(false))
    }
    this.frame = requestAnimationFrame(() => restore(true))
  }

  componentWillUnmount() { cancelAnimationFrame(this.frame) }
  render() { return this.props.children }
}
