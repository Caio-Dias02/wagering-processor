import { EntitySchema } from "@mikro-orm/core";

export class OutboxMessageRecord {
    id!: string;
    seq!: string;
    aggregateId!: string;
    eventType!: string;
    payload!: Record<string, unknown>;
    occurredAt!: Date;
    attempts!: number;
    nextAttemptAt!: Date;
    publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
    class: OutboxMessageRecord,
    tableName: "outbox_messages",
    properties: {
        id: { type: "uuid", primary: true },
        seq: { type: "bigint", autoincrement: true, unique: "outbox_seq_uq" },
        aggregateId: { type: "uuid" },
        eventType: { type: "text" },
        payload: { type: "json" },
        occurredAt: { type: "Date", columnType: "timestamptz" },
        attempts: { type: "integer", default: 0 },
        nextAttemptAt: { type: "Date", columnType: "timestamptz" },
        publishedAt: { type: "Date", columnType: "timestamptz", nullable: true },
    },
    indexes: [
        {
            name: "outbox_pending_idx",
            expression:
                `create index "outbox_pending_idx" on "outbox_messages" ` +
                `("next_attempt_at", "seq") where published_at is null`,
        },
    ],
    checks: [{ name: "outbox_attempts_non_negative_ck", expression: "attempts >= 0" }],
});