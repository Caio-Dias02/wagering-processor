import { EntitySchema } from "@mikro-orm/core";
import { WagerTransactionRecord } from "./wager-transaction.record";

export class WalletLedgerEntryRecord {
    id!: string;
    seq!: string;
    walletId!: string;
    transactionId!: string;
    direction!: string;
    amount!: string;
    currency!: string;
    balanceBefore!: string;
    balanceAfter!: string;
    createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: "wallet_ledger_entries",
    properties: {
        id: { type: "uuid", primary: true },
        seq: { type: "bigint", autoincrement: true, unique: "ledger_seq_uq" },
        // FK composta (wallet_id, currency) -> wallets fica na migration manual
        walletId: { type: "uuid" },
        transactionId: {
            kind: "m:1",
            entity: () => WagerTransactionRecord,
            mapToPk: true,
            fieldName: "transaction_id",
        },
        direction: { type: "text" },
        amount: { type: "decimal", precision: 19, scale: 2 },
        currency: { type: "string", columnType: "char(3)" },
        balanceBefore: { type: "decimal", precision: 19, scale: 2 },
        balanceAfter: { type: "decimal", precision: 19, scale: 2 },
        createdAt: { type: "Date", columnType: "timestamptz" },
    },
    uniques: [
        { name: "ledger_one_entry_per_tx_wallet_uq", properties: ["transactionId", "walletId"] },
    ],
    indexes: [{ name: "ledger_wallet_seq_idx", properties: ["walletId", "seq"] }],
    checks: [
        { name: "ledger_direction_ck", expression: "direction in ('DEBIT', 'CREDIT')" },
        { name: "ledger_amount_positive_ck", expression: "amount > 0" },
        { name: "ledger_balance_before_non_negative_ck", expression: "balance_before >= 0" },
        { name: "ledger_balance_after_non_negative_ck", expression: "balance_after >= 0" },
        {
            name: "ledger_arithmetic_ck",
            expression:
                "(direction = 'CREDIT' and balance_after = balance_before + amount) or " +
                "(direction = 'DEBIT' and balance_after = balance_before - amount)",
        },
    ],
});