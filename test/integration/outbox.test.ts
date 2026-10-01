import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DeleteMessageCommand, GetQueueUrlCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionProcessed } from "../../src/application/messaging/events";
import { OutboxMessage } from "../../src/application/messaging/outbox-message";
import type { EventPublisherPort } from "../../src/application/ports/event-publisher";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import {
    ProcessWagerTransaction,
    type ProcessWagerTransactionCommand,
} from "../../src/application/use-cases/process-wager-transaction";
import { PublishOutbox } from "../../src/application/use-cases/publish-outbox";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";
import { createSqsClient, sqsConfig } from "../../src/infrastructure/messaging/sqs.config";
import { PollingLoop } from "../../src/infrastructure/workers/polling-loop";

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let processTx: ProcessWagerTransaction;
let createWallet: CreateWallet;

beforeAll(async () => {
    orm = await MikroORM.init({ ...config, pool: { min: 2, max: 20 } });
    await orm.migrator.up();
    uow = new MikroOrmUnitOfWork(orm);
    processTx = new ProcessWagerTransaction(uow);
    createWallet = new CreateWallet(uow);
});

afterAll(async () => {
    await orm.close(true);
});

// O banco é compartilhado com os outros testes: cada teste começa com a outbox "limpa"
// (tudo marcado como publicado), para contar só o que ele mesmo gerou.
beforeEach(async () => {
    await sql("update outbox_messages set published_at = now() where published_at is null");
});

function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(query, params);
}

async function pendingEventTypes(aggregateIds: string[]): Promise<string[]> {
    const rows = await sql<{ event_type: string }>(
        `select event_type from outbox_messages where aggregate_id in (${aggregateIds.map(() => "?").join(", ")}) and published_at is null order by seq`,
        aggregateIds,
    );
    return rows.map((r) => r.event_type);
}

function newWallet(amount = "100.00"): Promise<Wallet> {
    return createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } });
}

function bet(wallet: Wallet, amount = "10.00"): ProcessWagerTransactionCommand {
    const externalTransactionId = Bun.randomUUIDv7();
    return {
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: "provider-a", externalTransactionId,
        playerId: wallet.playerId, walletId: wallet.id, roundId: "r1", gameId: "g1",
        kind: "BET", money: { amount, currency: "BRL" },
    };
}

/** Publisher falso que registra o que "publicou". */
class RecordingPublisher implements EventPublisherPort {
    readonly published: string[] = [];
    constructor(private readonly behavior: (m: OutboxMessage[]) => Promise<void> = async () => { }) { }

    async publish(messages: OutboxMessage[]): Promise<Set<string>> {
        await this.behavior(messages);
        this.published.push(...messages.map((m) => m.id));
        return new Set(messages.map((m) => m.id));
    }
}

/** Publica até a outbox esvaziar. */
async function drain(publisher: PublishOutbox): Promise<void> {
    while ((await publisher.execute()).claimed > 0) { /* próximo lote */ }
}

describe("outbox: gravação atômica", () => {
    test("abertura com saldo gera WalletBalanceChanged", async () => {
        const wallet = await newWallet();
        expect(await pendingEventTypes([wallet.id])).toEqual(["WalletBalanceChanged"]);
    });

    test("BET processada: Processed + BalanceChanged; rejeitada: Rejected; replay: nada", async () => {
        const wallet = await newWallet("15.00");
        await sql("update outbox_messages set published_at = now() where published_at is null");

        const ok = await processTx.execute(bet(wallet));
        const rejectedCmd = bet(wallet, "50.00");
        const rejected = await processTx.execute(rejectedCmd);
        await processTx.execute(rejectedCmd); // replay

        expect(await pendingEventTypes([ok.transactionId, wallet.id])).toEqual([
            "WagerTransactionProcessed",
            "WalletBalanceChanged",
        ]);
        expect(await pendingEventTypes([rejected.transactionId])).toEqual(["WagerTransactionRejected"]);
    });

    test("se a transação é desfeita, o evento some junto", async () => {
        const wallet = await newWallet();
        const opening = (await uow.run((ctx) => ctx.transactions.findByIdempotencyKey(`internal:opening:${wallet.id}`)))!;
        const event = WagerTransactionProcessed.from(opening, {
            correlationId: "c", occurredAt: new Date(), newId: () => Bun.randomUUIDv7(),
        });

        await expect(
            uow.run(async (ctx) => {
                await ctx.outbox.insert([OutboxMessage.enqueue(event)]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");

        const rows = await sql("select 1 from outbox_messages where id = ?", [event.eventId]);
        expect(rows).toHaveLength(0);
    });
});

describe("outbox: publicação", () => {
    test("publica os pendentes e marca como publicados", async () => {
        const wallet = await newWallet();
        const publisher = new RecordingPublisher();
        await drain(new PublishOutbox(uow, publisher));

        expect(publisher.published).toHaveLength(1);
        expect(await pendingEventTypes([wallet.id])).toEqual([]);
    });

    test("falha ao publicar: conta a tentativa e agenda para depois (não fica em loop)", async () => {
        const wallet = await newWallet();
        const failing = new PublishOutbox(uow, {
            publish: async () => { throw new Error("SQS fora do ar"); },
        });

        expect(await failing.execute()).toEqual({ claimed: 1, published: 0, failed: 1 });
        expect(await failing.execute()).toEqual({ claimed: 0, published: 0, failed: 0 }); // ainda não venceu

        const [row] = await sql<{ attempts: number; due_in_ms: number }>(
            `select attempts, (extract(epoch from (next_attempt_at - now())) * 1000)::float8 as due_in_ms
               from outbox_messages where aggregate_id = ?`,
            [wallet.id],
        );
        expect(row?.attempts).toBe(1);
        expect(row!.due_in_ms).toBeGreaterThan(0);
    });

    test("dois publishers concorrentes: cada evento publicado exatamente uma vez", async () => {
        const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet()));
        await Promise.all(wallets.flatMap((w) => Array.from({ length: 4 }, () => processTx.execute(bet(w)))));
        // 5 aberturas + 20 BETs × 2 eventos = 45

        // Publicação lenta, para os dois ficarem com lotes travados ao mesmo tempo.
        const slow = () => new RecordingPublisher(() => Bun.sleep(30));
        const a = slow();
        const b = slow();
        await Promise.all([drain(new PublishOutbox(uow, a)), drain(new PublishOutbox(uow, b))]);

        const all = [...a.published, ...b.published];
        expect(all).toHaveLength(45);
        expect(new Set(all).size).toBe(45);
        expect(a.published.length).toBeGreaterThan(0);
        expect(b.published.length).toBeGreaterThan(0);
    });

    test("commit financeiro feito, instância A publica e morre antes de marcar: B republica", async () => {
        const wallet = await newWallet();
        const result = await processTx.execute(bet(wallet)); // 1. o Postgres confirmou o commit

        // 2. A instância A trava o lote, chega a publicar e morre antes do commit dela.
        const a = new RecordingPublisher();
        await expect(
            uow.run(async (ctx) => {
                await a.publish(await ctx.outbox.claimDue(new Date(), 10));
                throw new Error("processo morreu");
            }),
        ).rejects.toThrow("processo morreu");
        expect(a.published).toHaveLength(3); // abertura + Processed + BalanceChanged

        // 3-4. A transação de A foi desfeita, as linhas destravaram: B assume e publica.
        const b = new RecordingPublisher();
        await drain(new PublishOutbox(uow, b));

        // 5. Os mesmos eventos (mesmos eventIds) saíram duas vezes: o consumidor deduplica por eventId.
        expect([...b.published].sort()).toEqual([...a.published].sort());
        expect(await pendingEventTypes([wallet.id, result.transactionId])).toEqual([]);
    });
});

describe("loop do worker", () => {
    test("publica sozinho e, no stop, termina o lote em andamento antes de parar", async () => {
        const wallet = await newWallet();
        let inFlight = 0;
        const publisher = new RecordingPublisher(async () => {
            inFlight++;
            await Bun.sleep(50);
            inFlight--;
        });
        const loop = new PollingLoop("test-outbox", async () => (await new PublishOutbox(uow, publisher).execute()).claimed > 0, {
            idleDelayMs: 20,
            errorDelayMs: 20,
        });

        loop.start();
        while (publisher.published.length === 0) await Bun.sleep(10);
        await loop.stop();

        expect(inFlight).toBe(0);
        expect(await pendingEventTypes([wallet.id])).toEqual([]);
    });
});

describe("outbox → SQS de verdade", () => {
    let sqs: SQSClient;
    let queueUrl: string;

    beforeAll(async () => {
        sqs = createSqsClient();
        queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: sqsConfig.eventsQueueName }))).QueueUrl!;
    });

    afterAll(() => sqs.destroy());

    test("o evento chega na fila com o envelope completo", async () => {
        const wallet = await newWallet("42.00");
        await drain(new PublishOutbox(uow, new SqsEventPublisher(sqs, sqsConfig.eventsQueueName)));

        // A fila acumula eventos de outros testes: procura o nosso.
        let found: Record<string, unknown> | undefined;
        for (let i = 0; i < 10 && !found; i++) {
            const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
                QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
            }));
            for (const m of Messages) {
                const body = JSON.parse(m.Body!);
                await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
                if (body.aggregateId === wallet.id) found = body;
            }
        }

        expect(found).toMatchObject({
            eventType: "WalletBalanceChanged",
            version: 1,
            data: { walletId: wallet.id, balanceAfter: { amount: "42.00", currency: "BRL" } },
        });
    });
});
