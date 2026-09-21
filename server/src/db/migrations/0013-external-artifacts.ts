import { createHash } from 'node:crypto'

export const EXTERNAL_ARTIFACTS_SQL = `
CREATE TABLE external_artifacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_assignment_id UUID NOT NULL,
  source_conversation_id TEXT NOT NULL,
  source_context_id UUID NOT NULL,
  title TEXT,
  input_text TEXT CHECK(length(input_text)<=8000),
  input_revision INTEGER NOT NULL DEFAULT 1 CHECK(input_revision>0),
  latest_version INTEGER NOT NULL DEFAULT 0 CHECK(latest_version>=0),
  content_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX external_artifacts_owner ON external_artifacts(company_id,owner_id,created_at);
CREATE INDEX external_artifacts_expiry ON external_artifacts(content_expires_at);
CREATE TABLE external_artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES external_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  input_revision INTEGER NOT NULL CHECK(input_revision>0),
  producer_id TEXT NOT NULL,
  source_delivery_id TEXT UNIQUE,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(artifact_id,version)
);
CREATE TABLE external_artifact_handoffs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES external_artifacts(id) ON DELETE CASCADE,
  source_version INTEGER NOT NULL,
  input_revision INTEGER NOT NULL CHECK(input_revision>0),
  assignee_id TEXT NOT NULL,
  assignment_id UUID NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  instructions TEXT CHECK(length(instructions)<=8000),
  status TEXT NOT NULL CHECK(status IN ('assigned','submitted','accepted','rejected','cancelled','stale')),
  output_version INTEGER,
  review_note TEXT CHECK(length(review_note)<=8000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(artifact_id,request_id),
  FOREIGN KEY(artifact_id,source_version) REFERENCES external_artifact_versions(artifact_id,version),
  FOREIGN KEY(artifact_id,output_version) REFERENCES external_artifact_versions(artifact_id,version)
);
CREATE INDEX external_artifact_handoffs_assignee ON external_artifact_handoffs(assignee_id,artifact_id);

-- Generic workspace upserts/renames must never mutate a fixed snapshot. Inserts
-- require a matching immutable ledger entry; expiry and trusted company deletion
-- may remove bodies without removing the version/handoff identity ledger.
CREATE FUNCTION protect_external_artifact_workspace() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.path LIKE 'external-artifacts/%' OR NEW.path LIKE 'external-artifacts/%' THEN
      RAISE EXCEPTION 'external artifact snapshots are immutable';
    END IF;
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.path LIKE 'external-artifacts/%'
      AND COALESCE(current_setting('cumora.external_artifact_cleanup_company',true),'') IS DISTINCT FROM OLD.company_id
      AND NOT EXISTS (
        SELECT 1 FROM external_artifacts a JOIN external_artifact_versions v ON v.artifact_id=a.id
        WHERE a.company_id=OLD.company_id AND a.producer_id=OLD.agent_id
          AND OLD.path='external-artifacts/'||a.id||'/'||v.version::text||'.json'
          AND a.content_expires_at<=clock_timestamp()
      ) THEN
      RAISE EXCEPTION 'external artifact snapshot has not expired';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.path LIKE 'external-artifacts/%' AND NOT EXISTS (
    SELECT 1 FROM external_artifacts a JOIN external_artifact_versions v ON v.artifact_id=a.id
    WHERE a.company_id=NEW.company_id AND a.producer_id=NEW.agent_id
      AND NEW.path='external-artifacts/'||a.id||'/'||v.version::text||'.json'
      AND a.content_expires_at>clock_timestamp()
      AND v.sha256=encode(sha256(convert_to(NEW.body,'UTF8')),'hex')
  ) THEN
    RAISE EXCEPTION 'external artifact snapshot does not match its ledger';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER agent_workspace_external_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_workspace
FOR EACH ROW EXECUTE FUNCTION protect_external_artifact_workspace();
`

export function externalArtifactsChecksum(): string {
  return createHash('sha256').update(EXTERNAL_ARTIFACTS_SQL).digest('hex')
}
