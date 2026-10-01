import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import type { OutboxMessage } from "../../../application/messaging/outbox-message";
import type { OutboxRepository } from "../../../application/ports/repositories";
import { OutboxMessageRecord } from "../entities/outbox-message.record";
import { OutboxMessageMapper } from "../mappers/outbox-message.mapper";

export class MikroOrmOutboxRepository implements OutboxRepository {
    constructor(private readonly em: EntityManager) { }

    async insert(messages: OutboxMessage[]): Promise<void> {
        if (messages.length === 0) return;
        await this.em.insertMany(OutboxMessageRecord, messages.map(OutboxMessageMapper.toRecord));
    }

    async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
        // PESSIMISTIC_PARTIAL_WRITE = "FOR UPDATE SKIP LOCKED": cada publisher pega um lote
        // diferente, sem esperar pelos outros. Usa o índice parcial outbox_pending_idx.
        const records = await this.em.find(
            OutboxMessageRecord,
            { publishedAt: null, nextAttemptAt: { $lte: now } },
            { orderBy: { seq: "asc" }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
        );
        return records.map(OutboxMessageMapper.toDomain);
    }

    async save(message: OutboxMessage): Promise<void> {
        await this.em.nativeUpdate(
            OutboxMessageRecord,
            { id: message.id },
            {
                attempts: message.attempts,
                nextAttemptAt: message.nextAttemptAt,
                publishedAt: message.publishedAt ?? null,
            },
        );
    }
}
