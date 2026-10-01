import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.factory";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
    // outbox e consumer têm testes próprios; aqui só HTTP
    process.env.OUTBOX_WORKER_ENABLED = "false";
    process.env.SQS_CONSUMER_ENABLED = "false";
    app = await createApp();
    app.useLogger(false); // os 500 de propósito não poluem a saída dos testes
    await app.get(MikroORM).migrator.up();
    await app.listen(0); // porta livre qualquer
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
    await app.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

async function newWallet(amount = "100.00") {
    const playerId = Bun.randomUUIDv7();
    const { status, body } = await call("POST", "/wallets", { playerId, initialBalance: { amount, currency: "BRL" } });
    expect(status).toBe(201);
    return body as { id: string; playerId: string };
}

function transaction(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    return {
        providerId: "provider-a",
        externalTransactionId: Bun.randomUUIDv7(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
        ...overrides,
    };
}

function submit(body: { providerId: string; externalTransactionId: string }, key = `${body.providerId}:${body.externalTransactionId}`) {
    return call("POST", "/wagering/transactions", body, { "Idempotency-Key": key });
}

describe("POST /wallets", () => {
    test("cria com 201 no formato do contrato", async () => {
        const playerId = Bun.randomUUIDv7();
        const { status, body } = await call("POST", "/wallets", {
            playerId, initialBalance: { amount: "1000.00", currency: "BRL" },
        });
        expect(status).toBe(201);
        expect(body).toEqual({
            id: expect.any(String), playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1,
        });
    });

    test("duplicada é 409", async () => {
        const wallet = await newWallet();
        const { status, body } = await call("POST", "/wallets", {
            playerId: wallet.playerId, initialBalance: { amount: "1.00", currency: "BRL" },
        });
        expect(status).toBe(409);
        expect(body.error.code).toBe("WALLET_ALREADY_EXISTS");
    });

    test("payload inválido é 400 com a lista de problemas", async () => {
        const { status, body } = await call("POST", "/wallets", { playerId: "x", initialBalance: 10 });
        expect(status).toBe(400);
        expect(body.error.issues).toHaveLength(2);
    });

    test("valor fora do formato é 400", async () => {
        const { status, body } = await call("POST", "/wallets", {
            playerId: Bun.randomUUIDv7(), initialBalance: { amount: "10.5", currency: "BRL" },
        });
        expect(status).toBe(400);
        expect(body.error.code).toBe("INVALID_MONEY");
    });

    test("JSON malformado é 400; corpo gigante é 413", async () => {
        expect((await call("POST", "/wallets", "{oops")).status).toBe(400);
        expect((await call("POST", "/wallets", { junk: "a".repeat(20_000) })).status).toBe(413);
    });
});

describe("POST /wagering/transactions", () => {
    test("processada: 200; replay: 200 com idempotentReplay", async () => {
        const wallet = await newWallet();
        const tx = transaction(wallet, { money: { amount: "25.00", currency: "BRL" } });

        const first = await submit(tx);
        expect(first.status).toBe(200);
        expect(first.body).toEqual({
            transactionId: expect.any(String),
            status: "PROCESSED",
            balance: { amount: "75.00", currency: "BRL" },
            failureCode: null,
            idempotentReplay: false,
        });

        const replay = await submit(tx);
        expect(replay.status).toBe(200);
        expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    test("mesma key com payload diferente: 409", async () => {
        const wallet = await newWallet();
        const tx = transaction(wallet);
        await submit(tx);

        const { status, body } = await submit({ ...tx, money: { amount: "11.00", currency: "BRL" } } as typeof tx);
        expect(status).toBe(409);
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    test("saldo insuficiente: 422 com failureCode, e replay repete o 422", async () => {
        const wallet = await newWallet("5.00");
        const tx = transaction(wallet);

        const first = await submit(tx);
        expect(first.status).toBe(422);
        expect(first.body.status).toBe("REJECTED");
        expect(first.body.failureCode).toBe("INSUFFICIENT_FUNDS");

        const replay = await submit(tx);
        expect(replay.status).toBe(422);
        expect(replay.body.idempotentReplay).toBe(true);
    });

    test("referência ainda não chegou: 202 PENDING_REFERENCE", async () => {
        const wallet = await newWallet();
        const { status, body } = await submit(transaction(wallet, {
            kind: "REFUND", referenceExternalTransactionId: "ainda-nao-chegou",
        }));
        expect(status).toBe(202);
        expect(body.status).toBe("PENDING_REFERENCE");
    });

    test("sem Idempotency-Key: 400", async () => {
        const wallet = await newWallet();
        const { status } = await call("POST", "/wagering/transactions", transaction(wallet));
        expect(status).toBe(400);
    });

    test("payloads inválidos: 400", async () => {
        const wallet = await newWallet();
        const invalid = [
            transaction(wallet, { money: { amount: "1e3", currency: "BRL" } }),
            transaction(wallet, { kind: "OPENING" }),
            transaction(wallet, { kind: "JACKPOT" }),
            transaction(wallet, { providerId: "internal" }),
            transaction(wallet, { walletId: "not-a-uuid" }),
            transaction(wallet, { kind: "REFUND" }), // sem referência
            transaction(wallet, { roundId: "a\u0000b" }), // NUL: o Postgres recusaria com 08P01
        ];
        for (const tx of invalid) {
            const { status } = await submit(tx);
            expect(status).toBe(400);
        }
    });

    test("wallet inexistente: 422 WALLET_NOT_FOUND", async () => {
        const wallet = await newWallet();
        const { status, body } = await submit(transaction(wallet, { walletId: Bun.randomUUIDv7() }));
        expect(status).toBe(422);
        expect(body.error.code).toBe("WALLET_NOT_FOUND");
    });

    test("20 envios simultâneos da mesma aposta via HTTP: um único débito", async () => {
        const wallet = await newWallet();
        const tx = transaction(wallet);

        const responses = await Promise.all(Array.from({ length: 20 }, () => submit(tx)));

        expect(responses.every((r) => r.status === 200)).toBe(true);
        expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
        const balance = await call("GET", `/wallets/${wallet.id}`);
        expect(balance.body.balance.amount).toBe("90.00");
    });
});

describe("consultas", () => {
    test("GET /wallets/:id e 404", async () => {
        const wallet = await newWallet();
        expect((await call("GET", `/wallets/${wallet.id}`)).body.balance.amount).toBe("100.00");
        expect((await call("GET", `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
        expect((await call("GET", "/wallets/nao-e-uuid")).status).toBe(404);
    });

    test("ledger paginado com cursor estável, sem repetir nem pular", async () => {
        const wallet = await newWallet();
        for (let i = 0; i < 4; i++) await submit(transaction(wallet));

        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
            const page = await call("GET", `/wallets/${wallet.id}/ledger${query}`);
            expect(page.status).toBe(200);
            seen.push(...page.body.items.map((e: { id: string }) => e.id));
            cursor = page.body.nextCursor;
        } while (cursor);

        expect(seen).toHaveLength(5); // OPENING + 4 BETs
        expect(new Set(seen).size).toBe(5);
    });

    test("ledger: cursor e limit inválidos são 400; wallet inexistente é 404", async () => {
        const wallet = await newWallet();
        expect((await call("GET", `/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
        expect((await call("GET", `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
        expect((await call("GET", `/wallets/${wallet.id}/ledger?limit=abc`)).status).toBe(400);
        const beyondBigint = Buffer.from("seq:9999999999999999999").toString("base64url");
        expect((await call("GET", `/wallets/${wallet.id}/ledger?cursor=${beyondBigint}`)).status).toBe(400);
        expect((await call("GET", `/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
    });

    test("transação por id interno e por id do provedor", async () => {
        const wallet = await newWallet();
        const tx = transaction(wallet);
        const { body } = await submit(tx);

        const byId = await call("GET", `/wagering/transactions/${body.transactionId}`);
        expect(byId.status).toBe(200);
        expect(byId.body).toMatchObject({ id: body.transactionId, kind: "BET", status: "PROCESSED" });

        const byExternal = await call("GET", `/providers/provider-a/wagering/transactions/${tx.externalTransactionId}`);
        expect(byExternal.body.id).toBe(body.transactionId);

        expect((await call("GET", `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
        expect((await call("GET", "/providers/provider-a/wagering/transactions/nao-existe")).status).toBe(404);
        expect((await call("GET", "/providers/p%00/wagering/transactions/x")).status).toBe(404);
    });

    test("health/live responde sem autenticação", async () => {
        expect((await call("GET", "/health/live")).status).toBe(200);
    });

    test("health/ready confere Postgres e SQS", async () => {
        const { status, body } = await call("GET", "/health/ready");
        expect(status).toBe(200);
        expect(body).toEqual({ status: "ok", checks: { postgres: "up", sqs: "up" } });
    });
});
