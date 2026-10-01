import { type Observability, noopObservability } from "../ports/observability";
import type { UnitOfWork } from "../ports/repositories";
import type { ReconcileWallet } from "./reconcile-wallet";

export interface ReconcileAllWalletsOptions {
    /** Nome da lease no banco. Muda só em teste, para cada teste ter a sua. */
    jobName: string;
    /** Intervalo mínimo entre duas varreduras, somando TODAS as instâncias. */
    intervalMs: number;
    /** Wallets lidas por página. */
    batchSize: number;
}

export const defaultReconcileAllWalletsOptions: ReconcileAllWalletsOptions = {
    jobName: "wallet-reconciliation",
    intervalMs: 60 * 60 * 1000,
    batchSize: 200,
};

export interface ReconciliationSweepResult {
    checked: number;
    /** Ids das wallets divergentes. Cada uma já foi logada e contada pelo ReconcileWallet. */
    divergent: string[];
    /** true se parou antes do fim porque a aplicação está desligando. */
    interrupted: boolean;
}

/**
 * Varredura periódica: reconcilia todas as wallets, uma de cada vez.
 *
 * Com várias instâncias rodando, só UMA faz a varredura em cada ciclo: antes de começar,
 * ela reivindica o job no banco (scheduled_jobs). As outras recebem false e pulam.
 * Se a instância cair no meio, aquele ciclo fica incompleto e o próximo recomeça do zero:
 * a varredura só lê, então repetir nunca faz mal.
 *
 * Cada wallet é conferida na própria transação curta (o snapshot é uma instrução só),
 * então a varredura não segura lock nem conexão enquanto as apostas continuam.
 */
export class ReconcileAllWallets {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly reconcileWallet: ReconcileWallet,
        private readonly observability: Observability = noopObservability,
        private readonly options: ReconcileAllWalletsOptions = defaultReconcileAllWalletsOptions,
    ) { }

    /** null quando outra instância já fez (ou está fazendo) a varredura deste ciclo. */
    async execute(shouldStop: () => boolean = () => false): Promise<ReconciliationSweepResult | null> {
        const { jobName, intervalMs, batchSize } = this.options;
        const claimed = await this.uow.run((ctx) => ctx.jobs.tryStart(jobName, intervalMs));
        if (!claimed) return null;

        const started = Date.now();
        const result: ReconciliationSweepResult = { checked: 0, divergent: [], interrupted: false };
        let afterId: string | undefined;

        for (; ;) {
            const ids = await this.uow.run((ctx) => ctx.wallets.listIds(afterId, batchSize));
            for (const id of ids) {
                if (shouldStop()) {
                    result.interrupted = true;
                    break;
                }
                const reconciliation = await this.reconcileWallet.execute(id);
                if (!reconciliation) continue; // não acontece hoje (wallet não é apagada), mas não custa
                result.checked++;
                if (!reconciliation.consistent) result.divergent.push(id);
            }
            if (result.interrupted || ids.length < batchSize) break;
            afterId = ids.at(-1);
        }

        const fields = {
            checked: result.checked,
            divergent: result.divergent.length,
            durationMs: Date.now() - started,
            interrupted: result.interrupted,
        };
        if (result.divergent.length > 0) {
            this.observability.logger.error("reconciliation sweep found divergent wallets", fields);
        } else {
            this.observability.logger.info("reconciliation sweep finished", fields);
        }
        return result;
    }
}
