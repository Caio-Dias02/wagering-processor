import { EntitySchema } from "@mikro-orm/core";
import { WalletRecord } from "./wallet.record";

export class WagerTransactionRecord {
    id!: string;
    providerId!: string;
    externalTransactionId!: string;
    idempotencyKey!: string;
    payloadHash!: string;
    walletId!: string;
    playerId!: string;
    roundId!: string;
    gameId!: string;
    kind!: string;
    amount!: string;
    currency!: string;
    referenceExternalTransactionId?: string | null;
    referenceTransactionId?: string | null;
    status!: string;
    failureCode?: string | null;
    observedBalance?: string | null;
    referenceAttempts!: number;
    nextReferenceAttemptAt?: Date | null;
    createdAt!: Date;
    processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
    class: WagerTransactionRecord,
    tableName: "wager_transactions",
    properties: {
        id: { type: "uuid", primary: true },
        providerId: { type: "text" },
        externalTransactionId: { type: "text" },
        idempotencyKey: { type: "text" },
        payloadHash: { type: "text" },
        walletId: {
            kind: "m:1",
            entity: () => WalletRecord,
            mapToPk: true,
            fieldName: "wallet_id",
        },
        playerId: { type: "uuid" },
        roundId: { type: "text" },
        gameId: { type: "text" },
        kind: { type: "text" },
        amount: { type: "decimal", precision: 19, scale: 2 },
        currency: { type: "string", columnType: "char(3)" },
        referenceExternalTransactionId: { type: "text", nullable: true },
        referenceTransactionId: {
            kind: "m:1",
            entity: () => WagerTransactionRecord,
            mapToPk: true,
            fieldName: "reference_transaction_id",
            nullable: true,
        },
        status: { type: "text" },
        failureCode: { type: "text", nullable: true },
        observedBalance: { type: "decimal", precision: 19, scale: 2, nullable: true },
        referenceAttempts: { type: "integer", default: 0 },
        nextReferenceAttemptAt: { type: "Date", columnType: "timestamptz", nullable: true },
        createdAt: { type: "Date", columnType: "timestamptz" },
        processedAt: { type: "Date", columnType: "timestamptz", nullable: true },
    },
    uniques: [
        { name: "wager_tx_idempotency_key_uq", properties: ["idempotencyKey"] },
        { name: "wager_tx_provider_external_uq", properties: ["providerId", "externalTransactionId"] },
        {
            name: "wager_tx_single_reversal_uq",
            expression:
                `create unique index "wager_tx_single_reversal_uq" on "wager_transactions" ` +
                `("reference_transaction_id", "kind") ` +
                `where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`,
        },
    ],
    indexes: [
        {
            name: "wager_tx_pending_reference_idx",
            expression:
                `create index "wager_tx_pending_reference_idx" on "wager_transactions" ` +
                `("next_reference_attempt_at") where status = 'PENDING_REFERENCE'`,
        },
    ],
    checks: [
        {
            name: "wager_tx_kind_ck",
            expression: "kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
        },
        {
            name: "wager_tx_status_ck",
            expression: "status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
        },
        { name: "wager_tx_amount_non_negative_ck", expression: "amount >= 0" },
        {
            name: "wager_tx_reference_required_ck",
            expression:
                "kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null",
        },
        {
            name: "wager_tx_opening_internal_ck",
            expression: "(kind = 'OPENING') = (provider_id = 'internal')",
        },
        {
            name: "wager_tx_failure_has_code_ck",
            expression: "status not in ('REJECTED', 'FAILED') or failure_code is not null",
        },
        {
            name: "wager_tx_terminal_has_date_ck",
            expression: "status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null",
        },
    ],
});