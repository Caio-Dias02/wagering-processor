import type { ProcessWagerTransactionResult } from "../application/use-cases/process-wager-transaction";
import type { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";

// Money vira { amount, currency } sozinho: JSON.stringify chama Money.toJSON().

export function presentWallet(w: Wallet) {
    return { id: w.id, playerId: w.playerId, balance: w.balance, version: w.version };
}

export function presentLedgerEntry(e: WalletLedgerEntry) {
    return {
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money,
        balanceBefore: e.balanceBefore,
        balanceAfter: e.balanceAfter,
        createdAt: e.createdAt.toISOString(),
    };
}

export function presentProcessResult(r: ProcessWagerTransactionResult) {
    return {
        transactionId: r.transactionId,
        status: r.status,
        balance: r.balance ?? null,
        failureCode: r.failureCode ?? null,
        idempotentReplay: r.idempotentReplay,
    };
}

export function presentTransaction(t: WagerTransaction) {
    return {
        id: t.id,
        providerId: t.providerId,
        externalTransactionId: t.externalTransactionId,
        walletId: t.walletId,
        playerId: t.playerId,
        roundId: t.roundId,
        gameId: t.gameId,
        kind: t.kind,
        money: t.money,
        referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
        referenceTransactionId: t.referenceTransactionId ?? null,
        status: t.status,
        failureCode: t.failureCode ?? null,
        balance: t.observedBalance ?? null,
        createdAt: t.createdAt.toISOString(),
        processedAt: t.processedAt?.toISOString() ?? null,
    };
}

/**
 * Cursor opaco do ledger: por baixo é o `seq` (bigserial), mas o cliente não
 * deve depender disso. Base64url permite trocar a implementação sem quebrar ninguém.
 */
export const ledgerCursor = {
    encode(seq: string): string {
        return Buffer.from(`seq:${seq}`).toString("base64url");
    },
    /** undefined se o cursor for inválido. */
    decode(cursor: string): string | undefined {
        const match = /^seq:(\d{1,19})$/.exec(Buffer.from(cursor, "base64url").toString());
        return match?.[1];
    },
};
