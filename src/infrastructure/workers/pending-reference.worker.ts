import {
    type BeforeApplicationShutdown,
    Inject,
    Injectable,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { ResolvePendingReference } from "../../application/use-cases/resolve-pending-reference";
import { PollingLoop } from "./polling-loop";

export const pendingReferenceWorkerConfig = {
    enabled: () => process.env.PENDING_REFERENCE_WORKER_ENABLED !== "false",
    idleDelayMs: Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1_000),
};

@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly loop: PollingLoop;

    constructor(@Inject(ResolvePendingReference) resolve: ResolvePendingReference) {
        this.loop = new PollingLoop(PendingReferenceWorker.name, async () => (await resolve.execute()) !== "none", {
            idleDelayMs: pendingReferenceWorkerConfig.idleDelayMs,
            errorDelayMs: 2_000,
        });
    }

    onApplicationBootstrap(): void {
        if (pendingReferenceWorkerConfig.enabled()) this.loop.start();
    }

    async beforeApplicationShutdown(): Promise<void> {
        await this.loop.stop();
    }
}
