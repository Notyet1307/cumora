import { createHash } from 'node:crypto'

export const INTEGRATION_MANAGEMENT_SQL = `
CREATE TABLE integration_revisions (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  config JSONB NOT NULL CHECK(jsonb_typeof(config)='object' AND config->>'schemaVersion'='1'
    AND jsonb_typeof(config->'connections')='array' AND jsonb_typeof(config->'bindings')='array'
    AND octet_length(config::text)<=262144),
  action TEXT NOT NULL CHECK(action IN ('save','import','rollback')),
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(company_id,revision)
);
CREATE TABLE integration_configs (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  config JSONB NOT NULL CHECK(jsonb_typeof(config)='object' AND config->>'schemaVersion'='1'
    AND jsonb_typeof(config->'connections')='array' AND jsonb_typeof(config->'bindings')='array'
    AND octet_length(config::text)<=262144),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(company_id,revision) REFERENCES integration_revisions(company_id,revision)
);
CREATE FUNCTION protect_integration_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM companies WHERE id=OLD.company_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'integration revisions are immutable';
END
$function$;
CREATE TRIGGER integration_revisions_immutable BEFORE UPDATE OR DELETE ON integration_revisions
FOR EACH ROW EXECUTE FUNCTION protect_integration_revision();
`

export function integrationManagementChecksum(): string {
  return createHash('sha256').update(INTEGRATION_MANAGEMENT_SQL).digest('hex')
}
