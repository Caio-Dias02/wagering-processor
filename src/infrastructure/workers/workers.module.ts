import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { UnitOfWork } from "../../application/ports/repositories";
import { ProcessWagerTransaction } from "../../application/use-cases/process-wager-transaction";
import { PublishOutbox } from "../../application/use-cases/publish-outbox";
import { UNIT_OF_WORK } from "../database/database.module";
import { SqsEventPublisher } from "../messaging/sqs-event-publisher";
import { defaultRetryDelaySeconds, SqsWagerTransactionConsumer } from "../messaging/sqs-wager-consumer";
import { sqsConfig } from "../messaging/sqs.config";
import { OutboxWorker } from "./outbox.worker";
import { SqsConsumerWorker } from "./sqs-consumer.worker";

@Module({
    providers: [
        {
            provide: PublishOutbox,
            inject: [UNIT_OF_WORK, SQSClient],
            useFactory: (uow: UnitOfWork, sqs: SQSClient) =>
                new PublishOutbox(uow, new SqsEventPublisher(sqs, sqsConfig.eventsQueueName)),
        },
        {
            provide: SqsWagerTransactionConsumer,
            inject: [UNIT_OF_WORK, SQSClient],
            // Mesmo caso de uso da API, montado aqui com a mesma unit of work.
            useFactory: (uow: UnitOfWork, sqs: SQSClient) =>
                new SqsWagerTransactionConsumer(sqs, new ProcessWagerTransaction(uow), {
                    queueName: sqsConfig.inputQueueName,
                    deadLetterQueueName: sqsConfig.deadLetterQueueName,
                    consumerName: "wager-transactions-consumer",
                    waitTimeSeconds: 10,
                    retryDelaySeconds: defaultRetryDelaySeconds,
                }),
        },
        OutboxWorker,
        SqsConsumerWorker,
    ],
    exports: [PublishOutbox, SqsWagerTransactionConsumer],
})
export class WorkersModule { }
