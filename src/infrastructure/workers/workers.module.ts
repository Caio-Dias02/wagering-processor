import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { UnitOfWork } from "../../application/ports/repositories";
import { PublishOutbox } from "../../application/use-cases/publish-outbox";
import { UNIT_OF_WORK } from "../database/database.module";
import { SqsEventPublisher } from "../messaging/sqs-event-publisher";
import { sqsConfig } from "../messaging/sqs.config";
import { OutboxWorker } from "./outbox.worker";

@Module({
    providers: [
        {
            provide: PublishOutbox,
            inject: [UNIT_OF_WORK, SQSClient],
            useFactory: (uow: UnitOfWork, sqs: SQSClient) =>
                new PublishOutbox(uow, new SqsEventPublisher(sqs, sqsConfig.eventsQueueName)),
        },
        OutboxWorker,
    ],
    exports: [PublishOutbox],
})
export class WorkersModule { }
