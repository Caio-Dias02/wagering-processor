import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
    ChangeMessageVisibilityCommand,
    GetQueueAttributesCommand,
    GetQueueUrlCommand,
    PurgeQueueCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError } from "../../src/application/errors";
import { payloadHash } from "../../src/application/payload-hash";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { ProcessWagerTransaction } from "../../src/application/use-cases/process-wager-transaction";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";
import { SqsWagerTransactionConsumer } from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { createSqsClient, sqsConfig } from "../../src/infrastructure/messaging/sqs.config";

const CONSUMER = "wager-transactions-consumer";

// Esperar mensagens voltarem por visibility timeout leva alguns segundos.
setDefaultTimeout(20_000);

let orm: MikroORM;
let sqs: SQSClient;
let processTx: ProcessWagerTransaction;
let createWallet: CreateWallet;
let queueUrl: string;
let dlqUrl: string;

beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    const uow = new MikroOrmUnitOfWork(orm);
    processTx = new ProcessWagerTransaction(uow);
    createWallet = new CreateWallet(uow);
    sqs = createSqsClient();
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: sqsConfig.inputQueueName }))).QueueUrl!;
    dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: sqsConfig.deadLetterQueueName }))).QueueUrl!;
});

afterAll(async () => {
    sqs.destroy();
    await orm.close(true);
});

beforeEach(async () => {
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
});

function consumerWith(useCase: Pick<ProcessWagerTransaction, "execute"> = processTx) {
    return new SqsWagerTransactionConsumer(sqs, useCase as ProcessWagerTransaction, {
        queueName: sqsConfig.inputQueueName,
        deadLetterQueueName: sqsConfig.deadLetterQueueName,
        consumerName: CONSUMER,
        waitTimeSeconds: 1,
        retryDelaySeconds: () => 0, // retry imediato, para o teste não esperar backoff
    });
}

function newWallet(amount = "100.00"): Promise<Wallet> {
    return createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } });
}

/** Mensagem no formato do §10. */
function message(wallet: Wallet, data: Record<string, unknown> = {}) {
    const externalTransactionId = Bun.randomUUIDv7();
    return {
        messageId: Bun.randomUUIDv7(),
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
            providerId: "provider-a",
            externalTransactionId,
            idempotencyKey: `provider-a:${externalTransactionId}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
            ...data,
        },
    };
}

/**
 * Publica na fila. `deduplicationId` diferente do messageId simula o provedor reenviando
 * a MESMA mensagem depois da janela de deduplicação do SQS (que é só uma otimização).
 */
async function send(body: unknown, groupId: string, deduplicationId = Bun.randomUUIDv7()) {
    await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: typeof body === "string" ? body : JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
    }));
}

/**
 * Consome até a fila ficar vazia DE VERDADE: sem mensagens visíveis nem em voo.
 * Só "dois polls vazios" não basta: uma mensagem pode estar invisível por um receive
 * abandonado (ex.: long polling de um processo que acabou de desligar) e voltar depois.
 */
async function drain(consumer: SqsWagerTransactionConsumer, maxPolls = 30) {
    let empty = 0;
    for (let i = 0; i < maxPolls; i++) {
        empty = (await consumer.pollOnce()) === 0 ? empty + 1 : 0;
        if (empty >= 2 && (await queueDepth(queueUrl)) === 0) return;
    }
}

async function queueDepth(url: string): Promise<number> {
    const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }));
    return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

async function deadLetters() {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ["All"],
    }));
    return Messages.map((m) => ({ body: m.Body, code: m.MessageAttributes?.errorCode?.StringValue }));
}

async function balanceOf(walletId: string): Promise<string> {
    const [row] = await orm.em.getConnection().execute<{ balance: string }[]>(
        "select balance::text from wallets where id = ?", [walletId],
    );
    return row!.balance;
}

async function debits(walletId: string): Promise<number> {
    const [row] = await orm.em.getConnection().execute<{ n: number }[]>(
        "select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId],
    );
    return row!.n;
}

describe("consumer SQS", () => {
    test("processa com o mesmo caso de uso da API, grava o inbox e dá ack", async () => {
        const wallet = await newWallet();
        const msg = message(wallet);
        await send(msg, wallet.id);

        await drain(consumerWith());

        expect(await balanceOf(wallet.id)).toBe("90.00");
        const inbox = await orm.em.getConnection().execute(
            "select processed_at from inbox_messages where consumer_name = ? and message_id = ?", [CONSUMER, msg.messageId],
        );
        expect(inbox).toHaveLength(1);
        expect(await queueDepth(queueUrl)).toBe(0);
    });

    test("a mesma mensagem entregue duas vezes debita uma vez só", async () => {
        const wallet = await newWallet();
        const msg = message(wallet);
        await send(msg, wallet.id);
        await send(msg, wallet.id); // redelivery (dedup id diferente: passa pela dedup do SQS)

        const results: { duplicateMessage: boolean }[] = [];
        await drain(consumerWith({
            execute: async (...args) => {
                const result = await processTx.execute(...args);
                results.push(result);
                return result;
            },
        }));

        // As duas entregas chegaram; a segunda foi barrada pelo inbox.
        expect(results.map((r) => r.duplicateMessage)).toEqual([false, true]);
        expect(await debits(wallet.id)).toBe(1);
        expect(await balanceOf(wallet.id)).toBe("90.00");
        expect(await queueDepth(queueUrl)).toBe(0);
    });

    test("rejeição de negócio é terminal: ack, e nada vai para a DLQ", async () => {
        const wallet = await newWallet("5.00");
        await send(message(wallet), wallet.id);

        await drain(consumerWith());

        const [tx] = await orm.em.getConnection().execute<{ status: string; failure_code: string }[]>(
            "select status, failure_code from wager_transactions where wallet_id = ? and kind = 'BET'", [wallet.id],
        );
        expect(tx).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
        expect(await queueDepth(queueUrl)).toBe(0);
        expect(await deadLetters()).toHaveLength(0);
    });

    test("erro permanente vai direto para a DLQ com o motivo", async () => {
        const wallet = await newWallet();
        await send(message(wallet, { money: { amount: "1e3", currency: "BRL" } }), wallet.id);
        await send("isto não é json", wallet.id);

        await drain(consumerWith());

        const codes = (await deadLetters()).map((d) => d.code).sort();
        expect(codes).toEqual(["INVALID_JSON", "INVALID_MONEY"]);
        expect(await queueDepth(queueUrl)).toBe(0);
        expect(await balanceOf(wallet.id)).toBe("100.00");
    });

    test("erro transitório: sem ack; depois de 5 recebimentos o SQS move para a DLQ", async () => {
        const wallet = await newWallet();
        await send(message(wallet), wallet.id);
        let attempts = 0;
        const failing = consumerWith({
            execute: async () => {
                attempts++;
                throw new TransientInfrastructureError("banco fora do ar");
            },
        });

        await drain(failing);

        expect(attempts).toBe(5); // maxReceiveCount da redrive policy
        expect(await deadLetters()).toHaveLength(1);
        expect(await queueDepth(queueUrl)).toBe(0);
        expect(await balanceOf(wallet.id)).toBe("100.00");
    });

    test("worker morre depois do commit e antes do ack: a mensagem volta e não debita de novo", async () => {
        const wallet = await newWallet();
        const msg = message(wallet);
        await send(msg, wallet.id);

        // Instância A: recebe, processa (commit!) e morre antes do delete.
        const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }));
        expect(Messages).toHaveLength(1);
        await processTx.execute({ ...msg.data, correlationId: msg.messageId } as never, {
            consumerName: CONSUMER, messageId: msg.messageId, payloadHash: payloadHash(msg), receivedAt: new Date(),
        });
        // A visibilidade expira (aqui, na hora) e a mensagem volta para a fila.
        await sqs.send(new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl, ReceiptHandle: Messages[0]!.ReceiptHandle, VisibilityTimeout: 0,
        }));

        // Instância B assume.
        await drain(consumerWith());

        expect(await debits(wallet.id)).toBe(1);
        expect(await balanceOf(wallet.id)).toBe("90.00");
        expect(await queueDepth(queueUrl)).toBe(0);
    });

    test("SIGTERM: termina a mensagem em andamento e devolve as que não começaram", async () => {
        const wallet = await newWallet();
        for (let i = 0; i < 3; i++) await send(message(wallet), wallet.id);

        let consumer: SqsWagerTransactionConsumer;
        let processed = 0;
        consumer = consumerWith({
            execute: async (...args) => {
                consumer.requestStop(); // o sinal chega no meio da primeira mensagem
                processed++;
                return processTx.execute(...args);
            },
        });
        await consumer.pollOnce();

        expect(processed).toBe(1);
        expect(await balanceOf(wallet.id)).toBe("90.00");
        // As outras duas voltaram para a fila e outra instância processa.
        await drain(consumerWith());
        expect(await balanceOf(wallet.id)).toBe("70.00");
    });
});

/**
 * A idempotência é da TRANSAÇÃO, não do canal: o provedor pode mandar pela API e
 * reenviar pela fila (ou o contrário). A key é a mesma, então o segundo é replay.
 * A API chama este mesmo caso de uso com o comando já validado (source "http").
 */
describe("idempotência entre API e fila", () => {
    function viaApi(msg: ReturnType<typeof message>) {
        return processTx.execute({ ...msg.data, source: "http" });
    }

    test("primeiro pela API, depois pela fila: a fila vira replay e debita uma vez só", async () => {
        const wallet = await newWallet();
        const msg = message(wallet);
        const first = await viaApi(msg);
        expect(first).toMatchObject({ status: "PROCESSED", idempotentReplay: false });

        const results: { transactionId: string; idempotentReplay: boolean }[] = [];
        await send(msg, wallet.id);
        await drain(consumerWith({
            execute: async (...args) => {
                const result = await processTx.execute(...args);
                results.push(result);
                return result;
            },
        }));

        expect(results).toEqual([expect.objectContaining({ transactionId: first.transactionId, idempotentReplay: true })]);
        expect(await debits(wallet.id)).toBe(1);
        expect(await balanceOf(wallet.id)).toBe("90.00");
        expect(await queueDepth(queueUrl)).toBe(0); // ack: replay é sucesso
        expect(await deadLetters()).toHaveLength(0);
    });

    test("primeiro pela fila, depois pela API: a API devolve o resultado original", async () => {
        const wallet = await newWallet();
        const msg = message(wallet);
        await send(msg, wallet.id);
        await drain(consumerWith());

        const replay = await viaApi(msg);

        expect(replay).toMatchObject({ status: "PROCESSED", idempotentReplay: true });
        expect(replay.balance?.toString()).toBe("90.00"); // saldo observado na 1ª vez
        expect(await debits(wallet.id)).toBe(1);
    });

    test("mesma key com payload diferente na fila: conflito vai para a DLQ, sem novo débito", async () => {
        const wallet = await newWallet();
        const msg = message(wallet);
        await viaApi(msg);

        const changed = { ...msg, messageId: Bun.randomUUIDv7(), data: { ...msg.data, money: { amount: "20.00", currency: "BRL" } } };
        await send(changed, wallet.id);
        await drain(consumerWith());

        expect((await deadLetters()).map((d) => d.code)).toEqual(["IDEMPOTENCY_CONFLICT"]);
        expect(await debits(wallet.id)).toBe(1);
        expect(await balanceOf(wallet.id)).toBe("90.00");
    });
});
