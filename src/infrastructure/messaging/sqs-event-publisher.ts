import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { OutboxMessage } from "../../application/messaging/outbox-message";
import type { EventPublisherPort } from "../../application/ports/event-publisher";

/**
 * Publica na fila FIFO de eventos.
 *  - MessageGroupId = aggregateId: eventos do mesmo agregado saem em ordem;
 *  - MessageDeduplicationId = eventId: o SQS descarta reenvios do mesmo evento por 5 min
 *    (otimização; a garantia de verdade é o consumidor deduplicar pelo eventId).
 */
export class SqsEventPublisher implements EventPublisherPort {
    private queueUrl: string | undefined;

    constructor(
        private readonly sqs: SQSClient,
        private readonly queueName: string,
    ) { }

    async publish(messages: OutboxMessage[]): Promise<Set<string>> {
        const result = await this.sqs.send(
            new SendMessageBatchCommand({
                QueueUrl: await this.resolveQueueUrl(),
                Entries: messages.map((m) => ({
                    Id: m.id,
                    MessageBody: JSON.stringify(m.payload),
                    MessageGroupId: m.aggregateId,
                    MessageDeduplicationId: m.id,
                    MessageAttributes: { eventType: { DataType: "String", StringValue: m.eventType } },
                })),
            }),
        );
        return new Set((result.Successful ?? []).map((s) => s.Id).filter((id): id is string => id !== undefined));
    }

    private async resolveQueueUrl(): Promise<string> {
        if (!this.queueUrl) {
            const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
            if (!QueueUrl) throw new Error(`Queue ${this.queueName} not found`);
            this.queueUrl = QueueUrl;
        }
        return this.queueUrl;
    }
}
