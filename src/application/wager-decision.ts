import { FailureCode } from "../domain/wager-transaction/failure-code";
import { type WagerTransaction, WagerTransactionKind } from "../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../domain/wallet/wallet-ledger-entry";
import { eventsForOutcome } from "./messaging/events";
import type { EventContext } from "./messaging/integration-event";
import { OutboxMessage } from "./messaging/outbox-message";
import type { TransactionalContext } from "./ports/repositories";

/**
 * Regras de negócio de uma transação, usadas por quem decide: o caso de uso
 * (transação nova) e o worker de PENDING_REFERENCE (transação esperando a referência).
 * Chamar SEMPRE com a wallet travada.
 */

export type Decision =
    /** tx foi para PROCESSED ou REJECTED. `entry` existe se o saldo mudou. */
    | { kind: "decided"; entry: WalletLedgerEntry | undefined }
    /** A referência ainda não chegou (ou chegou e também está esperando): tx não mudou. */
    | { kind: "reference-missing" };

export async function decideWagerTransaction(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    at: Date,
    newId: () => string,
): Promise<Decision> {
    const decided = (entry?: WalletLedgerEntry): Decision => ({ kind: "decided", entry });

    // Wallet de outro jogador: rejeita SEM expor o saldo dela.
    if (wallet.playerId !== tx.playerId) {
        tx.reject(FailureCode.WalletOwnershipMismatch, undefined, at);
        return decided();
    }
    // Sem saldo também: observed_balance é relido na moeda da TRANSAÇÃO, e aqui
    // a moeda da wallet é outra (o replay mostraria "100.00 USD" numa wallet BRL).
    if (wallet.currency !== tx.money.currency) {
        tx.reject(FailureCode.CurrencyMismatch, undefined, at);
        return decided();
    }

    // Resolve a referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS).
    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
        const found = await ctx.transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId);
        if (!found || !found.isTerminal()) return { kind: "reference-missing" };

        const problem = tx.checkReference(found) ?? (await checkNotReversed(ctx, found));
        if (problem) {
            tx.reject(problem, wallet.balance, at);
            return decided();
        }
        reference = found;
    }

    if (!tx.affectsBalance()) {
        tx.markProcessed(reference?.id, wallet.balance, at);
        return decided();
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
        const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
        tx.reject(code, wallet.balance, at);
        return decided();
    }
    if (direction === LedgerDirection.Credit && !wallet.canCredit(tx.money)) {
        tx.reject(FailureCode.BalanceLimitExceeded, wallet.balance, at);
        return decided();
    }

    const movement = { entryId: newId(), transactionId: tx.id, money: tx.money, at };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, wallet.balance, at);
    return decided(entry);
}

/**
 * Referência já revertida não aceita mais nada:
 *  - outra reversão, de QUALQUER tipo. O enunciado fala em "pelo mesmo tipo", mas
 *    REFUND depois de ROLLBACK da mesma BET devolveria o dinheiro duas vezes;
 *  - WIN/LOSS: não se liquida uma aposta que já foi cancelada.
 */
async function checkNotReversed(ctx: TransactionalContext, reference: WagerTransaction): Promise<FailureCode | undefined> {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
        if (await ctx.transactions.hasProcessedReversal(reference.id, kind)) {
            return FailureCode.ReferenceAlreadyReversed;
        }
    }
    return undefined;
}

/**
 * Grava o desfecho na transação SQL atual: saldo + ledger (se mudou) + eventos na outbox.
 * A própria transação de aposta é gravada por quem chama (insert se nova, update se pendente).
 */
export async function recordOutcome(
    ctx: TransactionalContext,
    tx: WagerTransaction,
    wallet: Wallet,
    expectedVersion: number,
    entry: WalletLedgerEntry | undefined,
    events: EventContext,
): Promise<void> {
    if (entry) {
        await ctx.wallets.save(wallet, expectedVersion);
        await ctx.ledger.insert(entry); // depois da transação de aposta: o ledger aponta para ela
    }
    const outcome = eventsForOutcome(tx, wallet, entry, events);
    await ctx.outbox.insert(outcome.map((e) => OutboxMessage.enqueue(e)));
}
