import { createHash } from 'node:crypto'

export const AGENT_EXECUTION_SQL = `
ALTER TABLE participants
  ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'native' CHECK (execution_kind IN ('native','external-service')),
  ADD COLUMN execution_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN execution_binding_id TEXT,
  ADD COLUMN execution_binding_version TEXT,
  ADD COLUMN execution_config_digest TEXT,
  ADD CONSTRAINT participants_execution_shape CHECK (
    (execution_kind='native' AND execution_binding_id IS NULL AND execution_binding_version IS NULL AND execution_config_digest IS NULL)
    OR (execution_kind='external-service' AND kind='agent' AND computer_id IS NULL AND engine IS NULL AND provider_profile IS NULL
      AND ((NOT execution_enabled AND execution_binding_id IS NULL AND execution_binding_version IS NULL AND execution_config_digest IS NULL)
        OR (execution_binding_id IS NOT NULL AND length(btrim(execution_binding_id))>0
          AND execution_binding_version IS NOT NULL AND length(btrim(execution_binding_version))>0
          AND execution_config_digest IS NOT NULL AND execution_config_digest ~ '^[a-f0-9]{64}$')))
  );
CREATE OR REPLACE FUNCTION rotate_participant_runtime_assignment_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $migration$
BEGIN
  IF NEW.execution_kind IS DISTINCT FROM OLD.execution_kind THEN
    RAISE EXCEPTION 'execution_kind is immutable; create a dedicated member';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.computer_id IS DISTINCT FROM OLD.computer_id
     OR NEW.provider_profile IS DISTINCT FROM OLD.provider_profile
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.departed_at IS DISTINCT FROM OLD.departed_at
     OR NEW.execution_enabled IS DISTINCT FROM OLD.execution_enabled
     OR NEW.execution_binding_id IS DISTINCT FROM OLD.execution_binding_id
     OR NEW.execution_binding_version IS DISTINCT FROM OLD.execution_binding_version
     OR NEW.execution_config_digest IS DISTINCT FROM OLD.execution_config_digest THEN
    NEW.runtime_assignment_id := gen_random_uuid()::text;
  END IF;
  RETURN NEW;
END;
$migration$;
DROP TRIGGER participants_runtime_assignment_rotation ON participants;
CREATE TRIGGER participants_runtime_assignment_rotation
BEFORE UPDATE OF company_id, computer_id, kind, departed_at, provider_profile, execution_kind,
  execution_enabled, execution_binding_id, execution_binding_version, execution_config_digest ON participants
FOR EACH ROW EXECUTE FUNCTION rotate_participant_runtime_assignment_id();
`

export function agentExecutionChecksum(): string {
  return createHash('sha256').update(AGENT_EXECUTION_SQL).digest('hex')
}
