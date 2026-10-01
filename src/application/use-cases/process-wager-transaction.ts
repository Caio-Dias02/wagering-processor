import { Money, type MoneyProps } from "../../domain/money/money";
import { FailureCode } from "../../domain/wager-transaction/failure-code";
import {
    WagerTransaction,
    WagerTransactionKind,
    type WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import { InvalidWagerTransactionError } from "../../domain/wager-transaction/wager-transaction.errors";
import type { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { IdempotencyConflictError, WalletNotFoundError } from "../errors";
import { payloadHash } from "../payload-hash";
import type { TransactionalContext, UnitOfWork } from "../ports/repositories";
import { retryOnConflict } from "../retry";

/** O que chega da API ou da fila (já sem nada de HTTP/SQS). */
export interface ProcessWagerTransactionCommand {
    idempotencyKey: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionResult {
    transactionId: string;
    status: WagerTransactionStatus;
    /** Saldo observado quando a transação foi decidida. Ausente se não puder ser exposto. */
    balance: Money | undefined;
    failureCode: FailureCode | undefined;
    idempotentReplay: boolean;
}

export class ProcessWagerTransaction {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly newId: () => string = () => Bun.randomUUIDv7(),
        private readonly now: () => Date = () => new Date(),
    ) { }

    async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
        // Validação do payload ANTES de abrir transação: erro de formato nem toca no banco.
        const hash = hashOf(command);
        const kind = parseKind(command.kind);
        const money = Money.from(command.money);

        // Se outra transação ganhar a corrida, repetimos numa NOVA transação. Na próxima
        // volta quem ganhou já está gravado, e caímos em replay ou conflito.
        return retryOnConflict(() => {
            const incoming = WagerTransaction.create({
                id: this.newId(),
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                idempotencyKey: command.idempotencyKey,
                payloadHash: hash,
                walletId: command.walletId,
                playerId: command.playerId,
                roundId: command.roundId,
                gameId: command.gameId,
                kind,
                money,
                referenceExternalTransactionId: command.referenceExternalTransactionId,
                createdAt: this.now(),
            });
            return this.uow.run((ctx) => this.process(ctx, incoming));
        });
    }

    private async process(ctx: TransactionalContext, tx: WagerTransaction): Promise<ProcessWagerTransactionResult> {
        // 1. Trava a wallet: daqui até o commit, ninguém mais mexe nela.
        const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) throw new WalletNotFoundError(tx.walletId);

        // 2. Já vimos esse pedido? (com a wallet travada, a resposta não muda até o commit)
        const existing = await this.findExisting(ctx, tx);
        if (existing) {
            if (!existing.matchesPayload(tx.payloadHash)) {
                throw new IdempotencyConflictError(
                    `Idempotency key ${tx.idempotencyKey} was already used with a different payload`,
                );
            }
            return toResult(existing, true);
        }

        // 3. Decide e aplica.
        const expectedVersion = wallet.version;
        const entry = await this.decide(ctx, wallet, tx);

        // 4. Grava tudo na mesma transação. Ordem importa por causa das FKs:
        //    transação → wallet → ledger (o ledger aponta para a transação).
        await ctx.transactions.insert(tx);
        if (entry) {
            await ctx.wallets.save(wallet, expectedVersion);
            await ctx.ledger.insert(entry);
        }

        return toResult(tx, false);
    }

    /** Mesmo pedido pela key OU pelo par (provider, externalTransactionId). */
    private async findExisting(ctx: TransactionalContext, tx: WagerTransaction): Promise<WagerTransaction | null> {
        const byKey = await ctx.transactions.findByIdempotencyKey(tx.idempotencyKey);
        if (byKey) return byKey;

        const byExternalId = await ctx.transactions.findByProviderAndExternalId(tx.providerId, tx.externalTransactionId);
        if (byExternalId) {
            throw new IdempotencyConflictError(
                `Transaction ${tx.externalTransactionId} from ${tx.providerId} was already submitted with another idempotency key`,
            );
        }
        return null;
    }

    /**
     * Aplica as regras e muda o estado de `tx` (e da wallet, se for o caso).
     * Devolve o lançamento do ledger, ou undefined se o saldo não mudou.
     */
    private async decide(
        ctx: TransactionalContext,
        wallet: Wallet,
        tx: WagerTransaction,
    ): Promise<WalletLedgerEntry | undefined> {
        const at = tx.createdAt;

        // Wallet de outro jogador: rejeita SEM expor o saldo dela.
        if (wallet.playerId !== tx.playerId) {
            tx.reject(FailureCode.WalletOwnershipMismatch, undefined, at);
            return undefined;
        }
        if (wallet.currency !== tx.money.currency) {
            tx.reject(FailureCode.CurrencyMismatch, wallet.balance, at);
            return undefined;
        }

        // Resolve a referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS).
        let reference: WagerTransaction | undefined;
        if (tx.referenceExternalTransactionId) {
            const found = await ctx.transactions.findByProviderAndExternalId(
                tx.providerId,
                tx.referenceExternalTransactionId,
            );
            // Ainda não chegou (ou chegou e está esperando a dela): guarda e tenta depois.
            if (!found || !found.isTerminal()) {
                tx.markPendingReference();
                return undefined;
            }

            const problem = tx.checkReference(found) ?? (await this.checkNotReversed(ctx, tx, found));
            if (problem) {
                tx.reject(problem, wallet.balance, at);
                return undefined;
            }
            reference = found;
        }

        if (!tx.affectsBalance()) {
            tx.markProcessed(reference?.id, wallet.balance, at);
            return undefined;
        }

        const direction = tx.ledgerDirectionFor(reference);
        if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
            const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
            tx.reject(code, wallet.balance, at);
            return undefined;
        }

        const movement = { entryId: this.newId(), transactionId: tx.id, money: tx.money, at };
        const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        tx.markProcessed(reference?.id, wallet.balance, at);
        return entry;
    }

    /**
     * Uma referência só pode ser revertida UMA vez, por qualquer tipo de reversão.
     * O enunciado fala em "pelo mesmo tipo", mas REFUND depois de ROLLBACK da mesma BET
     * devolveria o dinheiro duas vezes, então somos mais rígidos aqui.
     */
    private async checkNotReversed(
        ctx: TransactionalContext,
        tx: WagerTransaction,
        reference: WagerTransaction,
    ): Promise<FailureCode | undefined> {
        if (!tx.isReversal()) return undefined;
        for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
            if (await ctx.transactions.hasProcessedReversal(reference.id, kind)) {
                return FailureCode.ReferenceAlreadyReversed;
            }
        }
        return undefined;
    }
}

/** Só os campos de negócio entram no hash (sem a key, sem metadados de transporte). */
function hashOf(c: ProcessWagerTransactionCommand): string {
    return payloadHash({
        providerId: c.providerId,
        externalTransactionId: c.externalTransactionId,
        playerId: c.playerId,
        walletId: c.walletId,
        roundId: c.roundId,
        gameId: c.gameId,
        kind: c.kind,
        money: { amount: c.money.amount, currency: c.money.currency },
        referenceExternalTransactionId: c.referenceExternalTransactionId,
    });
}

function parseKind(kind: string): WagerTransactionKind {
    const valid = Object.values(WagerTransactionKind) as string[];
    if (!valid.includes(kind)) {
        throw new InvalidWagerTransactionError(`Unknown kind: ${kind}`);
    }
    return kind as WagerTransactionKind;
}

function toResult(tx: WagerTransaction, idempotentReplay: boolean): ProcessWagerTransactionResult {
    return {
        transactionId: tx.id,
        status: tx.status,
        balance: tx.observedBalance,
        failureCode: tx.failureCode,
        idempotentReplay,
    };
}
