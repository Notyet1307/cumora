export interface ArtifactActor {
  companyId: string
  subjectId: string
}

export interface ArtifactCitation {
  number: number
  knowledgeBaseId: string
  knowledgeId: string
  chunkId: string
  title: string
  content: string
  chunkIndex?: string | number
  level: 'same-turn-search'
}

export interface ArtifactVersion {
  version: number
  inputRevision: number
  producerId: string
  sourceDeliveryId: string | null
  sha256: string
  createdAt: string
  stale: boolean
}

export interface ArtifactContent extends ArtifactVersion {
  artifactId: string
  inputText: string
  expiresAt: string
  body: string
  citations: ArtifactCitation[]
  limitations: string[]
}

export type ArtifactHandoffStatus = 'assigned' | 'submitted' | 'accepted' | 'rejected' | 'cancelled' | 'stale'

export interface ArtifactHandoff {
  id: string
  sourceVersion: number
  assigneeId: string
  taskId: string
  instructions: string
  status: ArtifactHandoffStatus
  outputVersion: number | null
  reviewNote: string | null
  createdAt: string
}

export interface ArtifactSummary {
  id: string
  title: string
  ownerId: string
  sourceConversationId: string
  inputRevision: number
  inputText: string
  latestVersion: number
  expiresAt: string
  expired: boolean
}

export interface ArtifactView extends ArtifactSummary {
  versions: ArtifactVersion[]
  handoffs: ArtifactHandoff[]
}

export interface CaptureArtifactInput {
  deliveryId: string
  title?: string
  artifactId?: string
  expectedRevision?: number
}

export interface CreateArtifactHandoffInput {
  version: number
  expectedRevision: number
  assigneeId: string
  instructions: string
  requestId: string
}
