import { SQSClient } from "@aws-sdk/client-sqs";

/** Configuração do SQS (LocalStack por padrão). */
export const sqsConfig = {
    endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
    region: process.env.AWS_REGION ?? "us-east-1",
    inputQueueName: process.env.SQS_INPUT_QUEUE ?? "wager-transactions.fifo",
    deadLetterQueueName: process.env.SQS_DLQ ?? "wager-transactions-dlq.fifo",
    visibilityTimeoutSeconds: process.env.SQS_VISIBILITY_TIMEOUT_SECONDS
        ? Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS)
        : undefined,
    eventsQueueName: process.env.SQS_EVENTS_QUEUE ?? "wagering-events.fifo",
};

export function createSqsClient(): SQSClient {
    return new SQSClient({
        endpoint: sqsConfig.endpoint,
        region: sqsConfig.region,
        // LocalStack aceita qualquer credencial; em produção viriam do ambiente/IAM role.
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        },
    });
}
