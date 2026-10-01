import {
    type BeforeApplicationShutdown,
    Inject,
    Injectable,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { ReconcileAllWallets } from "../../application/use-cases/reconcile-all-wallets";
import { PollingLoop } from "./polling-loop";

export const reconciliationWorkerConfig = {
    enabled: () => process.env.RECONCILIATION_WORKER_ENABLED !== "false",
    intervalMs: Number(process.env.RECONCILIATION_INTERVAL_MS ?? 60 * 60 * 1000),
    /** De quanto em quanto tempo cada instância pergunta "é a minha vez?". */
    pollIntervalMs: Number(process.env.RECONCILIATION_POLL_INTERVAL_MS ?? 60_000),
};

/**
 * Agenda a varredura de reconciliação. Toda instância roda este loop, mas a lease no
 * banco faz só uma delas trabalhar por ciclo (ver ReconcileAllWallets).
 */
@Injectable()
export class ReconciliationWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly loop: PollingLoop;
    private stopping = false;

    constructor(@Inject(ReconcileAllWallets) sweep: ReconcileAllWallets) {
        // false sempre: depois de uma varredura (ou de perder a vez) não há trabalho imediato.
        this.loop = new PollingLoop(ReconciliationWorker.name, async () => {
            // Desligando: para entre uma wallet e outra, sem esperar a varredura inteira.
            await sweep.execute(() => this.stopping);
            return false;
        }, {
            idleDelayMs: reconciliationWorkerConfig.pollIntervalMs,
            errorDelayMs: reconciliationWorkerConfig.pollIntervalMs,
        });
    }

    onApplicationBootstrap(): void {
        if (reconciliationWorkerConfig.enabled()) this.loop.start();
    }

    async beforeApplicationShutdown(): Promise<void> {
        this.stopping = true;
        await this.loop.stop();
    }
}
