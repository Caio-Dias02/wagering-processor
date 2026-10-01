import type { MoneyProps } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wager-transaction/failure-code";
import type {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { type EventContext, IntegrationEvent } from "./integration-event";

/** Campos da transação que todo evento sobre ela carrega. */
interface TransactionSnapshot {
    transactionId: string;
    providerId: string;
    externalTransactionId: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    status: WagerTransactionStatus;
}

function snapshot(tx: WagerTransaction): TransactionSnapshot {
    return {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        status: tx.status,
    };
}

function envelope<T>(aggregateId: string, ctx: EventContext, data: T) {
    return {
        eventId: ctx.newId(),
        aggregateId,
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        occurredAt: ctx.occurredAt,
        data,
    };
}

// ---------- WagerTransactionProcessed ----------

export interface WagerTransactionProcessedData extends TransactionSnapshot {
    referenceTransactionId: string | null;
    observedBalance: MoneyProps | null;
}

/** Qualquer transação aplicada, inclusive LOSS (que não mexe no saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
    readonly eventType = "WagerTransactionProcessed";
    readonly version = 1;

    static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
        return new WagerTransactionProcessed(envelope(tx.id, ctx, {
            ...snapshot(tx),
            referenceTransactionId: tx.referenceTransactionId ?? null,
            observedBalance: tx.observedBalance?.toJSON() ?? null,
        }));
    }
}

// ---------- WagerTransactionRejected ----------

export interface WagerTransactionRejectedData extends TransactionSnapshot {
    failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
    readonly eventType = "WagerTransactionRejected";
    readonly version = 1;

    static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
        if (!tx.failureCode) throw new Error("Rejected transaction without failureCode");
        // Sem saldo aqui: a rejeição pode ser de quem nem é dono da wallet.
        return new WagerTransactionRejected(envelope(tx.id, ctx, { ...snapshot(tx), failureCode: tx.failureCode }));
    }
}

// ---------- WagerTransactionPendingReference ----------

export interface WagerTransactionPendingReferenceData extends TransactionSnapshot {
    referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
    readonly eventType = "WagerTransactionPendingReference";
    readonly version = 1;

    static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
        if (!tx.referenceExternalTransactionId) throw new Error("Pending reference without referenceExternalTransactionId");
        return new WagerTransactionPendingReference(envelope(tx.id, ctx, {
            ...snapshot(tx),
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
        }));
    }
}

// ---------- WalletBalanceChanged ----------

export interface WalletBalanceChangedData {
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
}

/** Somente quando o saldo muda (ou seja, quando existe lançamento no ledger). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
    readonly eventType = "WalletBalanceChanged";
    readonly version = 1;

    static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
        return new WalletBalanceChanged(envelope(wallet.id, ctx, {
            walletId: wallet.id,
            transactionId: entry.transactionId,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
        }));
    }
}
