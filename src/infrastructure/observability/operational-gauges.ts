import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Gauge, type Registry } from "prom-client";
import { sqsConfig } from "../messaging/sqs.config";

/**
 * Gauges calculados na hora da coleta (cada GET /metrics), direto da fonte:
 * não dependem de nenhum processo ter "lembrado" de atualizar, e funcionam igual
 * com 1 ou 3 instâncias (todas leem o mesmo banco e a mesma fila).
 * Se a fonte estiver fora do ar, o gauge simplesmente não é atualizado naquela coleta.
 */
export function registerOperationalGauges(registry: Registry, orm: MikroORM, sqs: SQSClient): void {
    const queueUrls = new Map<string, string>();
    const queueDepth = async (queueName: string): Promise<number> => {
        let url = queueUrls.get(queueName);
        if (!url) {
            url = (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl!;
            queueUrls.set(queueName, url);
        }
        const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }));
        return Number(Attributes.ApproximateNumberOfMessages ?? 0) + Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
    };

    const outbox = async () => {
        const [row] = await orm.em.getConnection().execute<{ pending: number; oldest_age: number | null }[]>(
            `select count(*)::int as pending,
                    extract(epoch from (now() - min(occurred_at)))::float8 as oldest_age
               from outbox_messages where published_at is null`,
        );
        return row ?? { pending: 0, oldest_age: null };
    };

    gauge(registry, "outbox_pending_messages", "Outbox messages not yet published", async () => (await outbox()).pending);
    gauge(registry, "outbox_lag_seconds", "Age of the oldest unpublished outbox message (0 when empty)",
        async () => (await outbox()).oldest_age ?? 0);
    gauge(registry, "pending_reference_transactions", "Transactions waiting for their reference", async () => {
        const [row] = await orm.em.getConnection().execute<{ n: number }[]>(
            "select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'",
        );
        return row?.n ?? 0;
    });
    gauge(registry, "sqs_dead_letter_queue_messages", "Messages in the dead-letter queue",
        () => queueDepth(sqsConfig.deadLetterQueueName));
    gauge(registry, "sqs_input_queue_messages", "Messages waiting in the input queue",
        () => queueDepth(sqsConfig.inputQueueName));
}

function gauge(registry: Registry, name: string, help: string, read: () => Promise<number>): void {
    new Gauge({
        name,
        help,
        registers: [registry],
        async collect() {
            try {
                this.set(await read());
            } catch {
                // fonte indisponível: mantém o último valor; /health/ready é quem acusa a queda
            }
        },
    });
}
