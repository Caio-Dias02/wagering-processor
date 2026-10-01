import type { Money } from "../../domain/money/money";
import { type LoggerPort, type MetricsPort, noopLogger, noopMetrics } from "../ports/observability";
import type { UnitOfWork } from "../ports/repositories";

export interface ReconciliationResult {
    walletId: string;
    storedBalance: Money;
    calculatedBalance: Money;
    /** stored - calculated. Zero quando consistente. */
    difference: Money;
    consistent: boolean;
    checkedEntries: number;
}

/**
 * Confere se o saldo guardado na wallet bate com a soma do ledger.
 * Divergência NUNCA é corrigida aqui: é logada, contada em métrica e devolvida na resposta.
 * Corrigir sozinho esconderia um bug (ou uma fraude) que alguém precisa investigar.
 */
export class ReconcileWallet {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly logger: LoggerPort = noopLogger,
        private readonly metrics: MetricsPort = noopMetrics,
    ) { }

    async execute(walletId: string): Promise<ReconciliationResult | null> {
        const snapshot = await this.uow.run((ctx) => ctx.ledger.reconciliationSnapshot(walletId));
        if (!snapshot) return null;

        const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
        const consistent = difference.isZero();

        this.metrics.increment("wallet_reconciliations_total", { result: consistent ? "consistent" : "divergent" });
        if (!consistent) {
            this.logger.error("wallet balance diverges from ledger", {
                walletId,
                // diferença e contagem ajudam a investigar; saldos completos ficam fora do log
                difference: difference.toString(),
                currency: difference.currency,
                checkedEntries: snapshot.checkedEntries,
            });
        }

        return { walletId, ...snapshot, difference, consistent };
    }
}
