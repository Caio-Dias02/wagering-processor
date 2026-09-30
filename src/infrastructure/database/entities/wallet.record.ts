import { EntitySchema } from "@mikro-orm/core";

export class WalletRecord {
    id!: string;
    playerId!: string;
    currency!: string;
    balance!: string;
    version!: number;
    createdAt!: Date;
    updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
    class: WalletRecord,
    tableName: "wallets",
    properties: {
        id: { type: "uuid", primary: true },
        playerId: { type: "uuid" },
        currency: { type: "string", columnType: "char(3)" },
        balance: { type: "decimal", precision: 19, scale: 2 },
        version: { type: "integer" },
        createdAt: { type: "Date", columnType: "timestamptz" },
        updatedAt: { type: "Date", columnType: "timestamptz" },
    },
    uniques: [
        { name: "wallets_player_currency_uq", properties: ["playerId", "currency"] },
        { name: "wallets_id_currency_uq", properties: ["id", "currency"] },
    ],
    checks: [
        { name: "wallets_balance_non_negative_ck", expression: "balance >= 0" },
        { name: "wallets_version_positive_ck", expression: "version >= 1" },
        { name: "wallets_currency_format_ck", expression: "currency ~ '^[A-Z]{3}$'" },
    ],
});