import { createHash } from 'node:crypto'

/** Additive EA-102 storage; no foreign key to native members for operator probes. */
export const EXTERNAL_INVOCATIONS_SQL = `
CREATE TABLE external_invocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind = 'operator-probe'),
  source_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  conversation_scope TEXT NOT NULL,
  input_text TEXT CHECK (length(input_text) <= 8000),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  session_scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','dispatching','running','completed','failed','canceled','unknown')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation>=0),
  lease_expires_at TIMESTAMPTZ,
  remote_ids JSONB,
  result JSONB CHECK (octet_length(result::text) <= 16777216),
  cancel_observation JSONB,
  observation_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  UNIQUE(company_id, subject_id, source_kind, source_id)
);
CREATE UNIQUE INDEX external_invocations_one_active_subject
  ON external_invocations(company_id, subject_id)
  WHERE status IN ('dispatching','running','unknown');
CREATE INDEX external_invocations_expiration ON external_invocations(content_expires_at)
  WHERE input_text IS NOT NULL OR result IS NOT NULL;
CREATE TABLE external_sessions (
  scope_key TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  scope JSONB NOT NULL CHECK (jsonb_typeof(scope)='object'),
  remote_session_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`

export function externalInvocationsChecksum(): string {
  return createHash('sha256').update(EXTERNAL_INVOCATIONS_SQL).digest('hex')
}
