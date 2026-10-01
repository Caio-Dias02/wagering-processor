import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Server } from "bun";
import { OutboxMessage } from "../../src/application/messaging/outbox-message";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";

/**
 * SQS falso: responde o GetQueueUrl, mas nunca responde o SendMessageBatch
 * (um broker travado, que aceita a conexão e não devolve nada).
 */
let server: Server<undefined>;
let sqs: SQSClient;

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        async fetch(req) {
            const target = req.headers.get("x-amz-target") ?? "";
            if (target.endsWith("GetQueueUrl")) {
                return Response.json(
                    { QueueUrl: `http://127.0.0.1:${server.port}/000000000000/events.fifo` },
                    { headers: { "content-type": "application/x-amz-json-1.0" } },
                );
            }
            await new Promise(() => { }); // trava para sempre
            return new Response();
        },
    });
    sqs = new SQSClient({
        endpoint: `http://127.0.0.1:${server.port}`,
        region: "us-east-1",
        useQueueUrlAsEndpoint: false,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
});

afterAll(() => {
    sqs.destroy();
    server.stop(true);
});

describe("SqsEventPublisher", () => {
    test("SQS travado: a publicação desiste no prazo em vez de prender a conexão do banco", async () => {
        const message = OutboxMessage.rehydrate({
            id: Bun.randomUUIDv7(),
            aggregateId: Bun.randomUUIDv7(),
            eventType: "WagerTransactionProcessed",
            payload: {},
            occurredAt: new Date(),
            attempts: 0,
            nextAttemptAt: new Date(),
            publishedAt: undefined,
        });
        const publisher = new SqsEventPublisher(sqs, "events.fifo", 200);

        const started = performance.now();
        await expect(publisher.publish([message])).rejects.toThrow();
        expect(performance.now() - started).toBeLessThan(2_000);
    });
});
