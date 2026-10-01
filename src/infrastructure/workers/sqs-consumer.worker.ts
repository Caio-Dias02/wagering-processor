import {
    type BeforeApplicationShutdown,
    Inject,
    Injectable,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { SqsWagerTransactionConsumer } from "../messaging/sqs-wager-consumer";
import { PollingLoop } from "./polling-loop";

export const sqsConsumerWorkerConfig = {
    enabled: () => process.env.SQS_CONSUMER_ENABLED !== "false",
};

@Injectable()
export class SqsConsumerWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly loop: PollingLoop;

    constructor(@Inject(SqsWagerTransactionConsumer) private readonly consumer: SqsWagerTransactionConsumer) {
        // O long polling já espera por mensagens; idleDelay curto só evita loop quente.
        this.loop = new PollingLoop(SqsConsumerWorker.name, async () => (await consumer.pollOnce()) > 0, {
            idleDelayMs: 100,
            errorDelayMs: 2_000,
        });
    }

    onApplicationBootstrap(): void {
        if (sqsConsumerWorkerConfig.enabled()) this.loop.start();
    }

    /** SIGTERM: para de receber, termina a mensagem atual, devolve as não iniciadas. */
    async beforeApplicationShutdown(): Promise<void> {
        this.consumer.requestStop();
        await this.loop.stop();
    }
}
