import type { ArtifactHandoff, ArtifactVersion, ArtifactView } from '../../shared/external-artifacts'
import type { Conversation, Message, Participant } from '../types'

export type ArtifactTimelineEvent = {
  kind: 'handoff'
  key: string
  at: string
  artifact: ArtifactView
  handoff: ArtifactHandoff
} | {
  kind: 'report'
  key: string
  at: string
  artifact: ArtifactView
  handoff: ArtifactHandoff
  version: ArtifactVersion
}

export type ConversationTimelineItem = { kind: 'message'; key: string; message: Message } | ArtifactTimelineEvent

/** Only the owner's exact two-person native DM receives derived delivery rows. */
export function artifactAssignee(
  conversation: Conversation | undefined,
  ownerId: string | null,
  participants: Record<string, Participant>,
): string | undefined {
  if (!ownerId || participants[ownerId]?.kind !== 'human' || conversation?.kind !== 'direct'
    || conversation.members.length !== 2 || !conversation.members.includes(ownerId)) return
  const peerId = conversation.members.find(id => id !== ownerId)
  const peer = peerId ? participants[peerId] : undefined
  return peer?.kind === 'agent' && peer.executionKind === 'native' ? peer.id : undefined
}

export function artifactTimeline(
  messages: Message[], artifacts: ArtifactView[], ownerId: string | null,
  assigneeId: string | undefined, hasMoreOlder: boolean,
): ConversationTimelineItem[] {
  const events: ArtifactTimelineEvent[] = []
  // Don't attach all historical tasks to the newest message page. The boundary
  // expands together with loaded message history; an empty complete DM has none.
  const oldest = hasMoreOlder ? Date.parse(messages[0]?.createdAt ?? messages[0]?.at ?? '') : -Infinity
  if (ownerId && assigneeId && (!hasMoreOlder || Number.isFinite(oldest))) {
    for (const artifact of artifacts) {
      if (artifact.ownerId !== ownerId) continue
      for (const handoff of artifact.handoffs) {
        if (handoff.assigneeId !== assigneeId) continue
        const key = `artifact:${artifact.id}:handoff:${handoff.id}`
        if (Date.parse(handoff.createdAt) >= oldest) {
          events.push({ kind: 'handoff', key, at: handoff.createdAt, artifact, handoff })
        }
        const version = artifact.versions.find(item => item.version === handoff.outputVersion)
        if (version && Date.parse(version.createdAt) >= oldest) {
          events.push({ kind: 'report', key: `${key}:output:${version.version}`, at: version.createdAt, artifact, handoff, version })
        }
      }
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)
    || (a.kind === b.kind ? 0 : a.kind === 'handoff' ? -1 : 1) || a.key.localeCompare(b.key))
  const items: ConversationTimelineItem[] = []
  let cursor = 0
  // Messages retain their store/sequence order (and optimistic client identity).
  // Equal timestamps put ordinary messages before the derived event.
  for (const message of messages) {
    const at = Date.parse(message.createdAt ?? message.at)
    while (cursor < events.length && Date.parse(events[cursor].at) < at) items.push(events[cursor++])
    items.push({ kind: 'message', key: `message:${message.clientId ?? message.id}`, message })
  }
  while (cursor < events.length) items.push(events[cursor++])
  return items
}

/** Keep the first surviving row's absolute Virtuoso index across prepends/removals. */
export function timelineFirstIndex(previous: ConversationTimelineItem[], next: ConversationTimelineItem[], firstIndex: number): number {
  if (previous[0] && previous[0].key === next[0]?.key) return firstIndex
  const positions = new Map(next.map((item, index) => [item.key, index]))
  for (let index = 0; index < previous.length; index++) {
    const nextIndex = positions.get(previous[index].key)
    if (nextIndex !== undefined) return firstIndex + index - nextIndex
  }
  return firstIndex
}

export function timelineMessageIndex(items: ConversationTimelineItem[], messageId: string): number {
  return items.findIndex(item => item.kind === 'message' && item.message.id === messageId)
}
