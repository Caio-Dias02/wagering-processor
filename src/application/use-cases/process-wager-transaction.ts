import { Money, type MoneyProps } from "../../domain/money/money";
import type { FailureCode } from "../../domain/wager-transaction/failure-code";
import {
    WagerTransaction,
    WagerTransactionKind,
    type WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import { InvalidWagerTransactionError } from "../../domain/wager-transaction/wager-transaction.errors";
import { IdempotencyConflictError, WalletNotFoundError } from "../errors";
import { InboxMessage } from "../messaging/inbox-message";
import type { EventContext } from "../messaging/integration-event";
import { payloadHash } from "../payload-hash";
import { Metric, type Observability, noopObservability } from "../ports/observability";
import type { TransactionalContext, UnitOfWork } from "../ports/repositories";
import { retryOnConflict } from "../retry";
import { decideWagerTransaction, recordOutcome } from "../wager-decision";

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
    /** Rastreamento: id do pedido de ponta a ponta (gerado se não vier). Não entra no hash. */
    correlationId?: string;
    /** Rastreamento: o que causou este pedido (ex.: messageId da fila). Não entra no hash. */
    causationId?: string;
    /** Por onde chegou (label de métrica). Não entra no hash. */
    source?: "http" | "sqs";
}

export interface ProcessWagerTransactionResult {
    transactionId: string;
    status: WagerTransactionStatus;
    /** Saldo observado quando a transação foi decidida. Ausente se não puder ser exposto. */
    balance: Money | undefined;
    failureCode: FailureCode | undefined;
    idempotentReplay: boolean;
    /** A mesma mensagem da fila já tinha sido processada (o inbox barrou). */
    duplicateMessage: boolean;
}

/** Quando o pedido vem da fila: registra a mensagem no inbox na mesma transação. */
export interface InboxOptions {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    receivedAt: Date;
}

export class ProcessWagerTransaction {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly observability: Observability = noopObservability,
        private readonly newId: () => string = () => Bun.randomUUIDv7(),
        private readonly now: () => Date = () => new Date(),
    ) { }

    async execute(command: ProcessWagerTransactionCommand, inbox?: InboxOptions): Promise<ProcessWagerTransactionResult> {
        const startedAt = performance.now();
        const trace = { correlationId: command.correlationId ?? this.newId(), causationId: command.causationId };
        const result = await this.run(command, trace, inbox);
        this.report(command, trace.correlationId, result, (performance.now() - startedAt) / 1000);
        return result;
    }

    private async run(
        command: ProcessWagerTransactionCommand,
        trace: Pick<EventContext, "correlationId" | "causationId">,
        inbox: InboxOptions | undefined,
    ): Promise<ProcessWagerTransactionResult> {
        // Validação do payload ANTES de abrir transação: erro de formato nem toca no banco.
        const hash = hashOf(command);
        const kind = parseKind(command.kind);
        const money = Money.from(command.money);
        const onConflict = () =>
            this.observability.metrics.increment(Metric.ConcurrencyConflicts, { operation: "process_wager_transaction" });

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
            return this.uow.run(async (ctx) => {
                if (inbox && !(await this.registerInbox(ctx, inbox))) {
                    return this.duplicateMessage(ctx, incoming, inbox);
                }
                return this.process(ctx, incoming, trace);
            });
        }, onConflict);
    }

    /** Uma linha de log por pedido + métricas. Só ids e códigos: nada de valores ou saldos. */
    private report(
        command: ProcessWagerTransactionCommand,
        correlationId: string,
        result: ProcessWagerTransactionResult,
        seconds: number,
    ): void {
        const source = command.source ?? "http";
        const { metrics, logger } = this.observability;
        metrics.increment(Metric.WagerTransactions, {
            source, kind: command.kind, status: result.status, replay: String(result.idempotentReplay),
        });
        metrics.observe(Metric.WagerProcessingSeconds, seconds, { source, status: result.status });
        if (result.duplicateMessage) metrics.increment(Metric.DuplicateMessages);

        logger.info(result.idempotentReplay ? "wager transaction replayed" : "wager transaction decided", {
            correlationId,
            messageId: command.causationId,
            transactionId: result.transactionId,
            walletId: command.walletId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            kind: command.kind,
            status: result.status,
            failureCode: result.failureCode,
            idempotentReplay: result.idempotentReplay,
            duplicateMessage: result.duplicateMessage,
            durationMs: Math.round(seconds * 1000),
        });
    }

    /**
     * Anota a mensagem no inbox. Como é a mesma transação do efeito financeiro, a
     * anotação só fica se o efeito ficar: "anotada" significa "processada".
     */
    private registerInbox(ctx: TransactionalContext, inbox: InboxOptions): Promise<boolean> {
        const message = InboxMessage.receive(inbox);
        message.markProcessed(inbox.receivedAt);
        return ctx.inbox.tryInsert(message);
    }

    /** Mensagem repetida: devolve o resultado da primeira vez, sem processar de novo. */
    private async duplicateMessage(
        ctx: TransactionalContext,
        tx: WagerTransaction,
        inbox: InboxOptions,
    ): Promise<ProcessWagerTransactionResult> {
        const original = await ctx.transactions.findByIdempotencyKey(tx.idempotencyKey);
        if (!original || !original.matchesPayload(tx.payloadHash)) {
            throw new IdempotencyConflictError(`Message ${inbox.messageId} was already processed with a different payload`);
        }
        return { ...toResult(original, true), duplicateMessage: true };
    }

    private async process(
        ctx: TransactionalContext,
        tx: WagerTransaction,
        trace: Pick<EventContext, "correlationId" | "causationId">,
    ): Promise<ProcessWagerTransactionResult> {
        // 1. Trava a wallet: daqui até o commit, ninguém mais mexe nela.
        const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) {
            // Key já usada (com outra wallet, que existe) continua sendo conflito, não "wallet inexistente".
            if (await this.findExisting(ctx, tx)) throw keyReusedWithDifferentPayload(tx);
            throw new WalletNotFoundError(tx.walletId);
        }

        // 2. Já vimos esse pedido? (com a wallet travada, a resposta não muda até o commit)
        const existing = await this.findExisting(ctx, tx);
        if (existing) {
            if (!existing.matchesPayload(tx.payloadHash)) throw keyReusedWithDifferentPayload(tx);
            return toResult(existing, true);
        }

        // 3. Decide e aplica. Referência ausente: guarda e o worker tenta depois.
        const expectedVersion = wallet.version;
        const decision = await decideWagerTransaction(ctx, wallet, tx, tx.createdAt, this.newId);
        if (decision.kind === "reference-missing") tx.markPendingReference();
        const entry = decision.kind === "decided" ? decision.entry : undefined;

        // 4. Grava tudo na mesma transação: a transação primeiro (o ledger aponta para ela),
        //    depois saldo + ledger + eventos na outbox. Os eventos só existem se o commit
        //    acontecer; replay não chega aqui, então não gera evento repetido.
        await ctx.transactions.insert(tx);
        await recordOutcome(ctx, tx, wallet, expectedVersion, entry, {
            ...trace, occurredAt: tx.createdAt, newId: this.newId,
        });

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

function keyReusedWithDifferentPayload(tx: WagerTransaction): IdempotencyConflictError {
    return new IdempotencyConflictError(`Idempotency key ${tx.idempotencyKey} was already used with a different payload`);
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
        duplicateMessage: false,
    };
}
