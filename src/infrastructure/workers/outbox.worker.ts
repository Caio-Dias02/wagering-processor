import {
    type BeforeApplicationShutdown,
    Inject,
    Injectable,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { PublishOutbox } from "../../application/use-cases/publish-outbox";
import { PollingLoop } from "./polling-loop";

/** Liga/desliga por ambiente: em testes o publisher é chamado na mão. */
export const outboxWorkerConfig = {
    enabled: () => process.env.OUTBOX_WORKER_ENABLED !== "false",
    idleDelayMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500),
};

@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly loop: PollingLoop;

    constructor(@Inject(PublishOutbox) publishOutbox: PublishOutbox) {
        this.loop = new PollingLoop(
            OutboxWorker.name,
            async () => {
                const { claimed } = await publishOutbox.execute();
                return claimed > 0; // lote cheio ou parcial: tenta de novo já; vazio: espera
            },
            { idleDelayMs: outboxWorkerConfig.idleDelayMs, errorDelayMs: 2_000 },
        );
    }

    onApplicationBootstrap(): void {
        if (outboxWorkerConfig.enabled()) this.loop.start();
    }

    /** Antes do onApplicationShutdown: o banco ainda está aberto para terminar o lote atual. */
    async beforeApplicationShutdown(): Promise<void> {
        await this.loop.stop();
    }
}
