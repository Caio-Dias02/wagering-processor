import { Money } from "../../../domain/money/money";
import {
    type LedgerDirection,
    WalletLedgerEntry,
} from "../../../domain/wallet/wallet-ledger-entry";
import type { WalletLedgerEntryRecord } from "../entities/wallet-ledger-entry.record";

export const WalletLedgerEntryMapper = {
    toDomain(r: WalletLedgerEntryRecord): WalletLedgerEntry {
        const money = (amount: string) => Money.rehydrate({ amount, currency: r.currency });
        return WalletLedgerEntry.rehydrate({
            id: r.id,
            walletId: r.walletId,
            transactionId: r.transactionId,
            direction: r.direction as LedgerDirection,
            money: money(r.amount),
            balanceBefore: money(r.balanceBefore),
            balanceAfter: money(r.balanceAfter),
            createdAt: r.createdAt,
        });
    },

    /** seq é gerado pelo banco, então não vai no insert. */
    toRecord(e: WalletLedgerEntry): Omit<WalletLedgerEntryRecord, "seq"> {
        return {
            id: e.id,
            walletId: e.walletId,
            transactionId: e.transactionId,
            direction: e.direction,
            amount: e.money.toString(),
            currency: e.money.currency,
            balanceBefore: e.balanceBefore.toString(),
            balanceAfter: e.balanceAfter.toString(),
            createdAt: e.createdAt,
        };
    },
};  