import { OutboxMessage } from "../../../application/messaging/outbox-message";
import type { OutboxMessageRecord } from "../entities/outbox-message.record";

export const OutboxMessageMapper = {
    toDomain(r: OutboxMessageRecord): OutboxMessage {
        return OutboxMessage.rehydrate({
            id: r.id,
            aggregateId: r.aggregateId,
            eventType: r.eventType,
            payload: r.payload,
            occurredAt: r.occurredAt,
            attempts: r.attempts,
            nextAttemptAt: r.nextAttemptAt,
            publishedAt: r.publishedAt ?? undefined,
        });
    },

    /** seq é gerado pelo banco, então não vai no insert. */
    toRecord(m: OutboxMessage): Omit<OutboxMessageRecord, "seq"> {
        return {
            id: m.id,
            aggregateId: m.aggregateId,
            eventType: m.eventType,
            // Cópia profunda: o MikroORM reescreve objetos aninhados no lugar ao montar a query,
            // e o `data` do evento é congelado (e não é dele para mexer).
            payload: structuredClone(m.payload) as Record<string, unknown>,
            occurredAt: m.occurredAt,
            attempts: m.attempts,
            nextAttemptAt: m.nextAttemptAt,
            publishedAt: m.publishedAt ?? null,
        };
    },
};
