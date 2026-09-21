import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { artifactAssignee, artifactTimeline, timelineFirstIndex, timelineMessageIndex } from '../src/lib/artifactTimeline'
import type { ArtifactHandoff, ArtifactView } from '../shared/external-artifacts'
import type { Conversation, Message, Participant } from '../src/types'

const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 10, minute)).toISOString()
const message = (id: string, minute: number): Message => ({ id, conversationId: 'dm', authorId: 'owner', kind: 'text', body: id, at: '10:00', createdAt: at(minute) })
const handoff = (status: ArtifactHandoff['status'] = 'submitted'): ArtifactHandoff => ({
  id: 'handoff', sourceVersion: 1, assigneeId: 'atlas', taskId: 'task', instructions: '整理报告',
  status, outputVersion: 2, reviewNote: null, createdAt: at(10),
})
const artifact = (handoffs = [handoff()]): ArtifactView => ({
  id: 'artifact', title: '合规报告', ownerId: 'owner', sourceConversationId: 'source',
  inputRevision: 1, inputText: '输入', latestVersion: 3, expiresAt: at(100), expired: false, handoffs,
  versions: [1, 2, 3].map(version => ({ version, inputRevision: 1, producerId: 'atlas', sourceDeliveryId: null,
    sha256: 'test-only', createdAt: at(version * 10), stale: false })),
})
const participants: Record<string, Participant> = {
  owner: { id: 'owner', kind: 'human', name: 'Owner', initial: 'O', avatarBg: '', status: 'avail' },
  atlas: { id: 'atlas', kind: 'agent', executionKind: 'native', name: 'Atlas', initial: 'A', avatarBg: '', status: 'avail' },
}
const conversation: Conversation = { id: 'dm', kind: 'direct', title: 'Atlas', members: ['owner', 'atlas'], lastAt: '', lastAtIso: '', preview: '' }

describe('artifact conversation timeline', () => {
  it('restricts recipient events to the owner’s exact two-person native DM', () => {
    assert.equal(artifactAssignee(conversation, 'owner', participants), 'atlas')
    assert.equal(artifactAssignee({ ...conversation, kind: 'group' }, 'owner', participants), undefined)
    assert.equal(artifactAssignee({ ...conversation, members: ['owner', 'atlas', 'other'] }, 'owner', participants), undefined)
    assert.equal(artifactAssignee(conversation, 'other', participants), undefined)
    assert.equal(artifactAssignee(conversation, 'owner', { ...participants, atlas: { ...participants.atlas, executionKind: 'external-service' } }), undefined)
    assert.deepEqual(artifactTimeline([], [artifact()], 'other', 'atlas', false), [])
    assert.deepEqual(artifactTimeline([], [artifact()], 'owner', 'other-agent', false), [])
  })

  it('keeps historical task/output events without messages and never substitutes the latest version', () => {
    const history = ['assigned', 'submitted', 'accepted', 'rejected', 'cancelled', 'stale'] as const
    const view = artifact(history.map(status => ({ ...handoff(status), id: status, outputVersion: status === 'assigned' ? null : 2 })))
    const rows = artifactTimeline([], [view], 'owner', 'atlas', false)
    assert.deepEqual(rows.filter(row => row.kind === 'handoff').map(row => row.handoff.status).sort(), [...history].sort())
    assert.deepEqual(rows.filter(row => row.kind === 'report').map(row => [row.handoff.id, row.version.version, row.at]),
      ['accepted', 'cancelled', 'rejected', 'stale', 'submitted'].map(id => [id, 2, at(20)]))
    assert.equal(new Set(rows.map(row => row.key)).size, 11)
    const missing = artifact([{ ...handoff(), outputVersion: 99 }])
    assert.deepEqual(artifactTimeline([], [missing], 'owner', 'atlas', false).map(row => row.kind), ['handoff'])
  })

  it('merges by durable timestamps, preserves message lookup and stable optimistic identity', () => {
    const view = artifact()
    const messages = [message('early', 5), message('equal', 10), message('middle', 15), { ...message('temporary', 25), clientId: 'client' }]
    const rows = artifactTimeline(messages, [view], 'owner', 'atlas', false)
    assert.deepEqual(rows.map(row => row.kind === 'message' ? row.message.id : row.kind), ['early', 'equal', 'handoff', 'middle', 'report', 'temporary'])
    assert.equal(timelineMessageIndex(rows, 'middle'), 3)
    assert.equal(timelineMessageIndex(rows, 'missing'), -1)
    const confirmed = artifactTimeline([...messages.slice(0, -1), { ...messages[3], id: 'confirmed' }], [view], 'owner', 'atlas', false)
    assert.equal(confirmed.at(-1)?.key, rows.at(-1)?.key)
    const reviewed = artifactTimeline(messages, [{ ...view, handoffs: [{ ...handoff(), status: 'accepted' }] }], 'owner', 'atlas', false)
    assert.deepEqual(reviewed.map(row => row.key), rows.map(row => row.key))
  })

  it('opens the history window with pagination and anchors every newly revealed row, not only messages', () => {
    const view = artifact()
    const newest = artifactTimeline([message('newest', 25)], [view], 'owner', 'atlas', true)
    assert.deepEqual(newest.map(row => row.key), ['message:newest'])
    const middle = artifactTimeline([message('middle', 15), message('newest', 25)], [view], 'owner', 'atlas', true)
    assert.deepEqual(middle.map(row => row.kind), ['message', 'report', 'message'])
    const complete = artifactTimeline([message('oldest', 5), message('middle', 15), message('newest', 25)], [view], 'owner', 'atlas', false)
    const middleIndex = timelineFirstIndex(newest, middle, 1000)
    assert.equal(middleIndex, 998)
    assert.equal(timelineFirstIndex(middle, complete, middleIndex), 996)
    assert.equal(996 + timelineMessageIndex(complete, 'newest'), 1000)
    assert.deepEqual(artifactTimeline([], [view], 'owner', 'atlas', true), [])
  })

  it('retains surviving absolute indexes through metadata arrival and revocation', () => {
    const messages = [message('middle', 15), message('newest', 25)]
    const before = artifactTimeline(messages, [], 'owner', 'atlas', false)
    const after = artifactTimeline(messages, [artifact()], 'owner', 'atlas', false)
    const index = timelineFirstIndex(before, after, 1000)
    assert.equal(index + timelineMessageIndex(after, 'middle'), 1000)
    assert.equal(timelineFirstIndex(after, before, index), 1000)
    const withoutFirst = after.slice(1)
    assert.equal(timelineFirstIndex(after, withoutFirst, index), index + 1)
  })
})
