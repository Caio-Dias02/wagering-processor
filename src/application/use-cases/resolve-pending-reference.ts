import { FailureCode } from "../../domain/wager-transaction/failure-code";
import type { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { Metric, type Observability, noopObservability } from "../ports/observability";
import type { UnitOfWork } from "../ports/repositories";
import { decideWagerTransaction, recordOutcome } from "../wager-decision";

/**
 * Política de novas tentativas para referências fora de ordem (§7.1).
 *
 * Provedores mandam a operação dependente segundos (no máximo poucos minutos) depois
 * da original. 8 tentativas com 5s, 10s, 20s ... (teto de 30 min) cobrem ~21 minutos:
 * folga grande para atraso real, e curto o bastante para o provedor receber
 * REFERENCE_NOT_FOUND no mesmo dia em vez de uma transação pendurada para sempre.
 */
export const pendingReferencePolicy = {
    maxAttempts: 8,
    baseDelayMs: 5_000,
    maxDelayMs: 30 * 60_000,
};

export type PendingReferencePolicy = typeof pendingReferencePolicy;

export type ResolveOutcome = "none" | "resolved" | "rescheduled" | "expired";

/**
 * Tenta resolver UMA transação PENDING_REFERENCE vencida. Várias instâncias podem rodar
 * ao mesmo tempo: cada uma trava a sua pendente (SKIP LOCKED) e depois a wallet, na mesma
 * ordem que o fluxo normal usa, então as regras são aplicadas sob o mesmo lock.
 */
export class ResolvePendingReference {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly policy: PendingReferencePolicy = pendingReferencePolicy,
        private readonly observability: Observability = noopObservability,
        private readonly newId: () => string = () => Bun.randomUUIDv7(),
        private readonly now: () => Date = () => new Date(),
    ) { }

    async execute(): Promise<ResolveOutcome> {
        const { outcome, tx } = await this.resolveOne();
        if (outcome !== "none" && tx) {
            this.observability.metrics.increment(Metric.PendingReferenceResolutions, { outcome });
            this.observability.logger.info(`pending reference ${outcome}`, {
                transactionId: tx.id,
                walletId: tx.walletId,
                providerId: tx.providerId,
                externalTransactionId: tx.externalTransactionId,
                referenceExternalTransactionId: tx.referenceExternalTransactionId,
                status: tx.status,
                failureCode: tx.failureCode,
            });
        }
        return outcome;
    }

    private resolveOne(): Promise<{ outcome: ResolveOutcome; tx?: WagerTransaction }> {
        return this.uow.run(async (ctx) => {
            const at = this.now();
            const claim = await ctx.transactions.claimDuePendingReference(at);
            if (!claim) return { outcome: "none" };

            const { transaction: tx, attempts } = claim;
            const wallet = await ctx.wallets.findByIdForUpdate(tx.walletId);
            if (!wallet) throw new Error(`Wallet ${tx.walletId} of pending transaction ${tx.id} not found`); // FK impede

            const expectedVersion = wallet.version;
            const decision = await decideWagerTransaction(ctx, wallet, tx, at, this.newId);
            const events = { correlationId: tx.id, causationId: tx.id, occurredAt: at, newId: this.newId };

            if (decision.kind === "decided") {
                await ctx.transactions.update(tx);
                await recordOutcome(ctx, tx, wallet, expectedVersion, decision.entry, events);
                return { outcome: "resolved", tx };
            }

            const attempt = attempts + 1;
            if (attempt >= this.policy.maxAttempts) {
                // Esgotou: rejeição definitiva, auditável, com evento (WagerTransactionRejected).
                tx.reject(FailureCode.ReferenceNotFound, wallet.balance, at);
                await ctx.transactions.update(tx);
                await recordOutcome(ctx, tx, wallet, expectedVersion, undefined, events);
                return { outcome: "expired", tx };
            }

            const delay = Math.min(this.policy.baseDelayMs * 2 ** (attempt - 1), this.policy.maxDelayMs);
            await ctx.transactions.scheduleReferenceRetry(tx.id, attempt, new Date(at.getTime() + delay));
            return { outcome: "rescheduled", tx };
        });
    }
}
