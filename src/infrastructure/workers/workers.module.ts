import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Observability } from "../../application/ports/observability";
import type { UnitOfWork } from "../../application/ports/repositories";
import { ProcessWagerTransaction } from "../../application/use-cases/process-wager-transaction";
import { PublishOutbox } from "../../application/use-cases/publish-outbox";
import { ResolvePendingReference } from "../../application/use-cases/resolve-pending-reference";
import { UNIT_OF_WORK } from "../database/database.module";
import { SqsEventPublisher } from "../messaging/sqs-event-publisher";
import { defaultRetryDelaySeconds, SqsWagerTransactionConsumer } from "../messaging/sqs-wager-consumer";
import { sqsConfig } from "../messaging/sqs.config";
import { OBSERVABILITY } from "../observability/observability.module";
import { OutboxWorker } from "./outbox.worker";
import { PendingReferenceWorker } from "./pending-reference.worker";
import { SqsConsumerWorker } from "./sqs-consumer.worker";

@Module({
    providers: [
        {
            provide: PublishOutbox,
            inject: [UNIT_OF_WORK, SQSClient, OBSERVABILITY],
            useFactory: (uow: UnitOfWork, sqs: SQSClient, observability: Observability) =>
                new PublishOutbox(uow, new SqsEventPublisher(sqs, sqsConfig.eventsQueueName), observability),
        },
        {
            provide: SqsWagerTransactionConsumer,
            inject: [UNIT_OF_WORK, SQSClient, OBSERVABILITY],
            // Mesmo caso de uso da API, montado aqui com a mesma unit of work.
            useFactory: (uow: UnitOfWork, sqs: SQSClient, observability: Observability) =>
                new SqsWagerTransactionConsumer(
                    sqs,
                    new ProcessWagerTransaction(uow, observability),
                    {
                        queueName: sqsConfig.inputQueueName,
                        deadLetterQueueName: sqsConfig.deadLetterQueueName,
                        consumerName: "wager-transactions-consumer",
                        waitTimeSeconds: 10,
                        visibilityTimeoutSeconds: sqsConfig.visibilityTimeoutSeconds,
                        retryDelaySeconds: defaultRetryDelaySeconds,
                    },
                    observability,
                ),
        },
        {
            provide: ResolvePendingReference,
            inject: [UNIT_OF_WORK, OBSERVABILITY],
            useFactory: (uow: UnitOfWork, observability: Observability) =>
                new ResolvePendingReference(uow, undefined, observability),
        },
        OutboxWorker,
        PendingReferenceWorker,
        SqsConsumerWorker,
    ],
    exports: [PublishOutbox, SqsWagerTransactionConsumer],
})
export class WorkersModule { }
