import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    GetQueueUrlCommand,
    type Message,
    ReceiveMessageCommand,
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import {
    ConcurrencyConflictError,
    IdempotencyConflictError,
    TransientInfrastructureError,
    WalletNotFoundError,
} from "../../application/errors";
import { InvalidInputError, parseWagerTransactionMessage } from "../../application/input-validation";
import { payloadHash } from "../../application/payload-hash";
import { Metric, type Observability, noopObservability } from "../../application/ports/observability";
import type { ProcessWagerTransaction } from "../../application/use-cases/process-wager-transaction";
import { DomainError } from "../../domain/shared/domain-error";

export interface SqsWagerConsumerOptions {
    queueName: string;
    deadLetterQueueName: string;
    consumerName: string;
    /** Long polling: quanto tempo o receive espera por mensagens (máx. 20). */
    waitTimeSeconds: number;
    /** Por quanto tempo uma mensagem recebida fica invisível para os outros consumers. Se o
     *  processo morrer, é o tempo até ela voltar para a fila. Ausente: o padrão da fila (30s). */
    visibilityTimeoutSeconds?: number;
    /** Quanto tempo a mensagem fica invisível antes de tentar de novo, por nº de recebimentos. */
    retryDelaySeconds: (receiveCount: number) => number;
}

/** Backoff exponencial: 2, 4, 8, 16... segundos, até 5 minutos. */
export const defaultRetryDelaySeconds = (receiveCount: number) => Math.min(2 ** receiveCount, 300);

type Outcome =
    | { kind: "ack"; duplicate: boolean }
    | { kind: "retry"; reason: string }
    | { kind: "dead-letter"; reason: string; code: string };

/**
 * Consome wager-transactions.fifo usando o MESMO caso de uso da API.
 *
 *  - ack (delete) só DEPOIS do commit: se o processo morrer antes do ack, a mensagem
 *    volta e o inbox impede o segundo processamento;
 *  - negócio (processada, rejeitada, pendente)  → ack;
 *  - transitório                                  → sem ack, invisível por um backoff;
 *    depois de maxReceiveCount recebimentos o SQS move para a DLQ (redrive policy);
 *  - permanente (repetir nunca vai funcionar)     → DLQ na hora, com o motivo.
 *
 * Mensagens de um lote são processadas em ordem: na fila FIFO o grupo é a wallet,
 * então a ordem por wallet é preservada.
 */
export class SqsWagerTransactionConsumer {
    private queueUrl: string | undefined;
    private deadLetterUrl: string | undefined;
    private stopping = false;
    private abort = new AbortController();

    constructor(
        private readonly sqs: SQSClient,
        private readonly processTransaction: ProcessWagerTransaction,
        private readonly options: SqsWagerConsumerOptions,
        private readonly observability: Observability = noopObservability,
        private readonly now: () => Date = () => new Date(),
    ) { }

    /** Busca um lote e processa. Devolve quantas mensagens recebeu. */
    async pollOnce(): Promise<number> {
        if (this.stopping) return 0;
        const queueUrl = await this.resolveQueueUrl();

        let messages: Message[];
        try {
            ({ Messages: messages = [] } = await this.sqs.send(
                new ReceiveMessageCommand({
                    QueueUrl: queueUrl,
                    MaxNumberOfMessages: 10,
                    WaitTimeSeconds: this.options.waitTimeSeconds,
                    VisibilityTimeout: this.options.visibilityTimeoutSeconds,
                    MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
                }),
                { abortSignal: this.abort.signal },
            ));
        } catch (error) {
            if (this.stopping) return 0; // receive interrompido pelo desligamento
            throw error;
        }

        for (const [index, message] of messages.entries()) {
            if (this.stopping) {
                // Desligando: as que nem começaram voltam para a fila na hora.
                await this.release(messages.slice(index));
                break;
            }
            await this.handle(message);
        }
        return messages.length;
    }

    /** Para de receber e interrompe o long polling. A mensagem em andamento termina. */
    requestStop(): void {
        this.stopping = true;
        this.abort.abort();
    }

    private async handle(message: Message): Promise<void> {
        const outcome = await this.process(message);
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
        const context = { sqsMessageId: message.MessageId, receiveCount };

        switch (outcome.kind) {
            case "ack":
                await this.delete(message);
                this.observability.metrics.increment(Metric.SqsMessages, { outcome: "ack", code: outcome.duplicate ? "DUPLICATE" : "OK" });
                break;
            case "retry":
                this.observability.metrics.increment(Metric.SqsMessages, { outcome: "retry", code: "TRANSIENT" });
                this.observability.logger.warn("transient failure, message will be retried", { reason: outcome.reason, ...context });
                await this.sqs.send(new ChangeMessageVisibilityCommand({
                    QueueUrl: await this.resolveQueueUrl(),
                    ReceiptHandle: message.ReceiptHandle,
                    VisibilityTimeout: this.options.retryDelaySeconds(receiveCount),
                }));
                break;
            case "dead-letter":
                this.observability.metrics.increment(Metric.SqsMessages, { outcome: "dead_letter", code: outcome.code });
                this.observability.logger.error("permanent failure, message sent to DLQ", { code: outcome.code, reason: outcome.reason, ...context });
                await this.sendToDeadLetter(message, outcome);
                await this.delete(message);
                break;
        }
    }

    private async process(message: Message): Promise<Outcome> {
        try {
            const body: unknown = JSON.parse(message.Body ?? "");
            const { messageId, command } = parseWagerTransactionMessage(body);
            const result = await this.processTransaction.execute({ ...command, source: "sqs" }, {
                consumerName: this.options.consumerName,
                messageId,
                payloadHash: payloadHash(body),
                receivedAt: this.now(),
            });
            return { kind: "ack", duplicate: result.duplicateMessage };
        } catch (error) {
            return classify(error);
        }
    }

    private async sendToDeadLetter(message: Message, outcome: Extract<Outcome, { kind: "dead-letter" }>): Promise<void> {
        await this.sqs.send(new SendMessageCommand({
            QueueUrl: await this.resolveDeadLetterUrl(),
            MessageBody: message.Body ?? "",
            MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: {
                errorCode: { DataType: "String", StringValue: outcome.code },
                errorReason: { DataType: "String", StringValue: outcome.reason.slice(0, 1000) },
            },
        }));
    }

    private async release(messages: Message[]): Promise<void> {
        const queueUrl = await this.resolveQueueUrl();
        await Promise.all(messages.map((m) =>
            this.sqs.send(new ChangeMessageVisibilityCommand({
                QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0,
            })),
        ));
    }

    private async delete(message: Message): Promise<void> {
        // Se o delete falhar, a mensagem volta depois e o inbox a reconhece como repetida.
        await this.sqs.send(new DeleteMessageCommand({
            QueueUrl: await this.resolveQueueUrl(), ReceiptHandle: message.ReceiptHandle,
        }));
    }

    private async resolveQueueUrl(): Promise<string> {
        this.queueUrl ??= await this.urlOf(this.options.queueName);
        return this.queueUrl;
    }

    private async resolveDeadLetterUrl(): Promise<string> {
        this.deadLetterUrl ??= await this.urlOf(this.options.deadLetterQueueName);
        return this.deadLetterUrl;
    }

    private async urlOf(queueName: string): Promise<string> {
        const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
        if (!QueueUrl) throw new Error(`Queue ${queueName} not found`);
        return QueueUrl;
    }
}

/** Repetir resolve? Transitório: sim. Permanente: nunca, então vai para a DLQ. */
function classify(error: unknown): Outcome {
    const reason = error instanceof Error ? error.message : String(error);

    if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError) {
        return { kind: "retry", reason };
    }
    if (error instanceof SyntaxError) {
        return { kind: "dead-letter", reason: "body is not valid JSON", code: "INVALID_JSON" };
    }
    if (
        error instanceof InvalidInputError ||
        error instanceof IdempotencyConflictError ||
        error instanceof WalletNotFoundError ||
        error instanceof DomainError
    ) {
        return { kind: "dead-letter", reason, code: error.code };
    }
    // Erro desconhecido (provável bug): tenta de novo; se persistir, o redrive manda para a DLQ.
    return { kind: "retry", reason };
}
