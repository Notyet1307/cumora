import type { PoolClient } from 'pg'
import { CH_MESSAGE_NEW, type MessageNewEvent } from './redis.js'
import { enqueueBroadcast } from './realtime-outbox.js'

/** Authorized callers hold participant → conversation locks. Native policy stays in its caller. */
export async function persistReply(tx: PoolClient, companyId: string, message: MessageNewEvent['message'],
  externalDeliveryId?: string): Promise<void> {
  await tx.query(`INSERT INTO messages
    (id,conversation_id,author_id,kind,body,sequence,attachment,quoted_message_id,company_id,external_delivery_id,external_result)
    VALUES($1,$2,$3,'text',$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb)`,
  [message.id, message.conversationId, message.authorId, message.body, message.sequence,
    message.attachment ? JSON.stringify(message.attachment) : null, message.quotedMessageId ?? null,
    companyId, externalDeliveryId ?? null, message.externalResult ? JSON.stringify(message.externalResult) : null])
  await tx.query('UPDATE conversations SET updated_at=NOW() WHERE id=$1 AND company_id=$2', [message.conversationId, companyId])
  await tx.query(`INSERT INTO conversation_reads(user_id,conversation_id,last_read_at) VALUES($1,$2,NOW())
    ON CONFLICT(user_id,conversation_id) DO UPDATE SET last_read_at=NOW()`, [message.authorId, message.conversationId])
  await enqueueBroadcast(tx, CH_MESSAGE_NEW, { type: 'message.new', companyId, conversationId: message.conversationId, message })
}
