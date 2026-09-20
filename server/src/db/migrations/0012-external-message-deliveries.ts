import { createHash } from 'node:crypto'

export const EXTERNAL_MESSAGE_DELIVERIES_SQL = `
ALTER TABLE external_invocations DROP CONSTRAINT external_invocations_source_kind_check;
ALTER TABLE external_invocations ADD CONSTRAINT external_invocations_source_kind_check CHECK (source_kind IN ('operator-probe','chat-message'));
ALTER TABLE external_sessions ADD COLUMN content_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days';
ALTER TABLE conversations ADD COLUMN external_context_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE FUNCTION rotate_external_conversation_context() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' AND NOT (pg_trigger_depth()>1 AND COALESCE(current_setting('cumora.external_projection_write',true),'')=OLD.conversation_id) THEN
    UPDATE conversations SET external_context_id=gen_random_uuid() WHERE id=OLD.conversation_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NOT (pg_trigger_depth()>1 AND COALESCE(current_setting('cumora.external_projection_write',true),'')=NEW.conversation_id) THEN
    UPDATE conversations SET external_context_id=gen_random_uuid() WHERE id=NEW.conversation_id;
  END IF;
  RETURN NULL;
END
$function$;
CREATE TRIGGER conversation_members_external_context AFTER INSERT OR UPDATE OR DELETE ON conversation_members
FOR EACH ROW EXECUTE FUNCTION rotate_external_conversation_context();
CREATE FUNCTION fence_external_conversation_context() RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.members IS DISTINCT FROM OLD.members THEN
    NEW.external_context_id=gen_random_uuid();
  ELSIF NEW.external_context_id IS DISTINCT FROM OLD.external_context_id THEN
    NEW.external_context_id=gen_random_uuid();
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER conversations_external_context BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION fence_external_conversation_context();
-- A legacy BEFORE UPDATE projection write must not recursively UPDATE its own
-- conversation tuple. Rotate NEW there; direct normalized writes rotate above.
CREATE OR REPLACE FUNCTION synchronize_conversation_members_projection()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  expected JSONB;
  previous_projection TEXT;
BEGIN
  SELECT COALESCE(jsonb_agg(cm.participant_id ORDER BY cm.ordinal,cm.participant_id),'[]'::jsonb)
    INTO expected FROM conversation_members cm WHERE cm.conversation_id=NEW.id AND cm.company_id=NEW.company_id;
  IF NEW.members IS NOT DISTINCT FROM expected THEN RETURN NEW; END IF;
  previous_projection=COALESCE(current_setting('cumora.external_projection_write',true),'');
  PERFORM set_config('cumora.external_projection_write',NEW.id,true);
  DELETE FROM conversation_members WHERE conversation_id=OLD.id;
  INSERT INTO conversation_members(conversation_id,company_id,participant_id,ordinal,joined_at)
    SELECT NEW.id,NEW.company_id,seeded.participant_id,seeded.ordinal,NOW()
    FROM (
      SELECT DISTINCT ON(member.id) member.id AS participant_id,(member.ord-1)::integer AS ordinal
      FROM jsonb_array_elements_text(NEW.members) WITH ORDINALITY AS member(id,ord)
      WHERE member.id NOT LIKE 'external:%' ORDER BY member.id,member.ord
    ) seeded;
  PERFORM set_config('cumora.external_projection_write',previous_projection,true);
  SELECT COALESCE(jsonb_agg(cm.participant_id ORDER BY cm.ordinal,cm.participant_id),'[]'::jsonb)
    INTO NEW.members FROM conversation_members cm WHERE cm.conversation_id=NEW.id AND cm.company_id=NEW.company_id;
  NEW.external_context_id=gen_random_uuid();
  RETURN NEW;
END
$function$;
CREATE TABLE external_message_deliveries (
  id TEXT PRIMARY KEY,
  acceptance_order BIGSERIAL UNIQUE NOT NULL,
  company_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_author_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  assignment_id UUID NOT NULL,
  context_id UUID NOT NULL,
  snapshot JSONB,
  input_digest TEXT NOT NULL,
  input_text TEXT CHECK (length(input_text)<=8000),
  text_only BOOLEAN NOT NULL DEFAULT FALSE,
  invocation_id TEXT UNIQUE REFERENCES external_invocations(id),
  final_message_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','blocked_unknown','withheld','completed','failed')),
  status_version INTEGER NOT NULL DEFAULT 0 CHECK(status_version>=0),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
  UNIQUE(company_id,member_id,source_message_id)
);
CREATE INDEX external_deliveries_pending ON external_message_deliveries(company_id,member_id,acceptance_order)
WHERE status IN ('queued','running','blocked_unknown') OR (status='failed' AND final_message_id IS NULL);
CREATE INDEX external_deliveries_room ON external_message_deliveries(company_id,conversation_id,source_sequence);
ALTER TABLE messages ADD COLUMN external_delivery_id TEXT UNIQUE REFERENCES external_message_deliveries(id);
ALTER TABLE messages ADD COLUMN external_result JSONB;
`

export function externalMessageDeliveriesChecksum(): string {
  return createHash('sha256').update(EXTERNAL_MESSAGE_DELIVERIES_SQL).digest('hex')
}
