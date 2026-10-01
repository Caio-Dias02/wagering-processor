import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueUrlCommand, PurgeQueueCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Subprocess } from "bun";
import { createSqsClient, sqsConfig } from "../../src/infrastructure/messaging/sqs.config";

/**
 * Sobe processos REAIS da aplicação (bun src/main.ts), cada um na sua porta, todos
 * apontando para o mesmo Postgres e a mesma fila. Nada é simulado: é o mesmo binário
 * que rodaria em produção, com API, consumer SQS, outbox e worker de pendentes ligados.
 */
class Instance {
    private constructor(
        readonly name: string,
        readonly url: string,
        private readonly process: Subprocess,
    ) { }

    static async start(name: string, port: number): Promise<Instance> {
        const process = Bun.spawn(["bun", "src/main.ts"], {
            env: {
                ...Bun.env,
                PORT: String(port),
                LOG_LEVEL: "error",
                // explícito: o processo de teste pode ter herdado flags de outros testes
                OUTBOX_WORKER_ENABLED: "true",
                SQS_CONSUMER_ENABLED: "true",
                PENDING_REFERENCE_WORKER_ENABLED: "true",
                RECONCILIATION_WORKER_ENABLED: "true",
                OUTBOX_POLL_INTERVAL_MS: "100",
                // instância morta: a mensagem que ela segurava volta para a fila em 3s
                SQS_VISIBILITY_TIMEOUT_SECONDS: "3",
            },
            stdout: "ignore",
            stderr: "inherit",
        });
        const instance = new Instance(name, `http://127.0.0.1:${port}`, process);
        await instance.waitUntilReady();
        return instance;
    }

    /** Morte súbita, sem shutdown gracioso (equivale a kill -9 / queda da máquina). */
    async kill(): Promise<void> {
        this.process.kill("SIGKILL");
        await this.process.exited;
    }

    /** Desligamento normal (SIGTERM). */
    async stop(): Promise<void> {
        if (this.process.exitCode !== null || this.process.killed) return;
        this.process.kill("SIGTERM");
        await Promise.race([this.process.exited, Bun.sleep(10_000)]);
        if (this.process.exitCode === null) await this.kill();
    }

    private async waitUntilReady(): Promise<void> {
        for (let i = 0; i < 120; i++) {
            try {
                if ((await fetch(`${this.url}/health/ready`)).status === 200) return;
            } catch { /* ainda subindo */ }
            await Bun.sleep(250);
        }
        throw new Error(`${this.name} did not become ready`);
    }
}

let instances: Instance[] = [];
let sqs: SQSClient;
let queueUrl: string;

beforeAll(async () => {
    sqs = createSqsClient();
    queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: sqsConfig.inputQueueName }))).QueueUrl!;
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    instances = await Promise.all([Instance.start("A", 3101), Instance.start("B", 3102), Instance.start("C", 3103)]);
}, 60_000);

afterAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    sqs.destroy();
}, 60_000);

// ---------- helpers ----------

async function json(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function newWallet(amount = "100.00") {
    const playerId = Bun.randomUUIDv7();
    const { status, body } = await json("POST", `${instances[0]!.url}/wallets`, {
        playerId, initialBalance: { amount, currency: "BRL" },
    });
    expect(status).toBe(201);
    return { id: body.id as string, playerId };
}

type WalletRef = { id: string; playerId: string };

function betPayload(wallet: WalletRef, amount = "1.00") {
    return {
        providerId: "provider-a",
        externalTransactionId: Bun.randomUUIDv7(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount, currency: "BRL" },
    };
}

/**
 * Envia o pedido; se a instância não responder (morreu no meio), reenvia a MESMA
 * Idempotency-Key para a próxima instância viva, como um provedor faria.
 */
async function submitWithFailover(payload: ReturnType<typeof betPayload>, startAt: number) {
    const key = `${payload.providerId}:${payload.externalTransactionId}`;
    for (let attempt = 0; attempt < 10; attempt++) {
        const target = instances[(startAt + attempt) % instances.length]!;
        try {
            return await json("POST", `${target.url}/wagering/transactions`, payload, { "Idempotency-Key": key });
        } catch {
            await Bun.sleep(100); // conexão recusada/derrubada: tenta outra instância
        }
    }
    throw new Error("no instance answered");
}

async function sendToQueue(payload: ReturnType<typeof betPayload>) {
    await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: payload.walletId,
        MessageDeduplicationId: payload.externalTransactionId,
        MessageBody: JSON.stringify({
            messageId: Bun.randomUUIDv7(),
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` },
        }),
    }));
}

async function reconcile(wallet: WalletRef) {
    return (await json("POST", `${instances[0]!.url}/wallets/${wallet.id}/reconciliation`)).body;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, what: string) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await Bun.sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** Invariante final de todos os testes: saldo == ledger, sem correção nenhuma. */
async function expectConsistent(wallet: WalletRef, balance: string) {
    const r = await reconcile(wallet);
    expect(r.consistent).toBe(true);
    expect(r.storedBalance.amount).toBe(balance);
}

// ---------- cenários ----------

describe("3 instâncias da aplicação ao mesmo tempo", () => {
    test("a mesma aposta enviada 30x, espalhada pelas 3 instâncias: um único débito", async () => {
        const wallet = await newWallet();
        const payload = betPayload(wallet, "10.00");
        const key = `provider-a:${payload.externalTransactionId}`;

        const responses = await Promise.all(Array.from({ length: 30 }, (_, i) =>
            json("POST", `${instances[i % 3]!.url}/wagering/transactions`, payload, { "Idempotency-Key": key }),
        ));

        expect(responses.every((r) => r.status === 200)).toBe(true);
        expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
        expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
        const r = await reconcile(wallet);
        expect(r.checkedEntries).toBe(2); // abertura + um débito
        await expectConsistent(wallet, "90.00");
    }, 30_000);

    test("100 / 80 / 80 com cada aposta numa instância diferente", async () => {
        const wallet = await newWallet("100.00");
        const [first, second] = await Promise.all([
            json("POST", `${instances[1]!.url}/wagering/transactions`, ...withKey(betPayload(wallet, "80.00"))),
            json("POST", `${instances[2]!.url}/wagering/transactions`, ...withKey(betPayload(wallet, "80.00"))),
        ]);

        expect([first.body.status, second.body.status].sort()).toEqual(["PROCESSED", "REJECTED"]);
        expect([first.status, second.status].sort()).toEqual([200, 422]);
        await expectConsistent(wallet, "20.00");
    }, 30_000);

    test("as 3 instâncias consomem a mesma fila: cada mensagem processada uma vez", async () => {
        const wallets = await Promise.all(Array.from({ length: 3 }, () => newWallet()));
        await Promise.all(wallets.flatMap((w) => Array.from({ length: 10 }, () => sendToQueue(betPayload(w)))));

        await waitFor(async () => (await reconcile(wallets[2]!)).checkedEntries === 11
            && (await reconcile(wallets[0]!)).checkedEntries === 11
            && (await reconcile(wallets[1]!)).checkedEntries === 11, 30_000, "queue to be consumed");

        for (const w of wallets) await expectConsistent(w, "90.00");
    }, 45_000);

    test("uma instância morre no meio da carga e outra sobe: nada duplica, nada se perde", async () => {
        const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet()));

        // Carga pela fila (10 por wallet) e pela API (5 por wallet), tudo ao mesmo tempo.
        const queueLoad = Promise.all(wallets.flatMap((w) => Array.from({ length: 10 }, () => sendToQueue(betPayload(w)))));
        const httpLoad = Promise.all(wallets.flatMap((w, wi) =>
            Array.from({ length: 5 }, (_, i) => submitWithFailover(betPayload(w), wi + i)),
        ));

        // No meio disso, a instância B morre sem aviso (sem shutdown gracioso)...
        await Bun.sleep(300);
        const victim = instances[1]!;
        await victim.kill();
        // ...e uma nova instância D sobe no lugar dela (o "restart").
        instances[1] = await Instance.start("D", 3104);

        const httpResults = await httpLoad;
        await queueLoad;
        expect(httpResults.every((r) => r.status === 200)).toBe(true);

        // Mensagens que B segurava voltam para a fila (visibility timeout) e são reprocessadas.
        await waitFor(async () => {
            const all = await Promise.all(wallets.map(reconcile));
            return all.every((r) => r.checkedEntries === 16); // abertura + 15 débitos
        }, 45_000, "all 75 bets to be applied");

        for (const w of wallets) await expectConsistent(w, "85.00");

        // E a outbox esvazia: as instâncias vivas publicam o que ficou para trás.
        await waitFor(async () => {
            const metrics = await (await fetch(`${instances[0]!.url}/metrics`)).text();
            return /^outbox_pending_messages 0$/m.test(metrics);
        }, 30_000, "outbox to be drained");
    }, 120_000);
});

function withKey(payload: ReturnType<typeof betPayload>): [unknown, Record<string, string>] {
    return [payload, { "Idempotency-Key": `${payload.providerId}:${payload.externalTransactionId}` }];
}
