import { Money } from "../../../domain/money/money";
import { Wallet } from "../../../domain/wallet/wallet";
import type { WalletRecord } from "../entities/wallet.record";

export const WalletMapper = {
    toDomain(r: WalletRecord): Wallet {
        return Wallet.rehydrate({
            id: r.id,
            playerId: r.playerId,
            currency: r.currency,
            balance: Money.rehydrate({ amount: r.balance, currency: r.currency }),
            version: r.version,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        });
    },

    toRecord(w: Wallet): WalletRecord {
        return {
            id: w.id,
            playerId: w.playerId,
            currency: w.currency,
            balance: w.balance.toString(),
            version: w.version,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
        };
    },
};