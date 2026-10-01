import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Registry } from "prom-client";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { ProcessWagerTransaction } from "../../src/application/use-cases/process-wager-transaction";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";
import { PrometheusMetrics } from "../../src/infrastructure/observability/prometheus-metrics";

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
    orm = await MikroORM.init(config);
    await orm.migrator.up();
    uow = new MikroOrmUnitOfWork(orm);
});

afterAll(async () => {
    await orm.close(true);
});

function setup() {
    const lines: string[] = [];
    const registry = new Registry();
    const observability = {
        logger: new JsonLogger("info", (line) => lines.push(line)),
        metrics: new PrometheusMetrics(registry),
    };
    return { lines, registry, useCase: new ProcessWagerTransaction(uow, observability) };
}

function newWallet(amount: string): Promise<Wallet> {
    return new CreateWallet(uow).execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } });
}

function bet(wallet: Wallet, amount: string, correlationId?: string) {
    const externalTransactionId = Bun.randomUUIDv7();
    return {
        idempotencyKey: `provider-a:${externalTransactionId}`, providerId: "provider-a", externalTransactionId,
        playerId: wallet.playerId, walletId: wallet.id, roundId: "r1", gameId: "g1",
        kind: "BET", money: { amount, currency: "BRL" }, correlationId,
    };
}

describe("observabilidade do processamento", () => {
    test("log estruturado com os ids pedidos no §12, e sem nenhum valor ou saldo", async () => {
        const { lines, useCase } = setup();
        const wallet = await newWallet("4321.98");
        const command = bet(wallet, "1234.56", "corr-abc");

        const result = await useCase.execute(command);

        const log = JSON.parse(lines[0]!);
        expect(log).toMatchObject({
            level: "info",
            msg: "wager transaction decided",
            correlationId: "corr-abc",
            transactionId: result.transactionId,
            walletId: wallet.id,
            providerId: "provider-a",
            status: "PROCESSED",
        });
        // Nem o valor da aposta, nem o saldo antes/depois aparecem em lugar nenhum da linha.
        for (const amount of ["1234.56", "4321.98", "3087.42"]) expect(lines[0]).not.toContain(amount);
    });

    test("métricas: transação por status, replay e latência", async () => {
        const { registry, useCase } = setup();
        const wallet = await newWallet("10.00");
        const ok = bet(wallet, "5.00");
        await useCase.execute(ok);
        await useCase.execute(ok); // replay
        await useCase.execute(bet(wallet, "50.00")); // rejeitada

        const text = await registry.metrics();
        expect(text).toContain('wager_transactions_total{source="http",kind="BET",status="PROCESSED",replay="false"} 1');
        expect(text).toContain('wager_transactions_total{source="http",kind="BET",status="PROCESSED",replay="true"} 1');
        expect(text).toContain('wager_transactions_total{source="http",kind="BET",status="REJECTED",replay="false"} 1');
        expect(text).toContain('wager_transaction_processing_seconds_count{source="http",status="PROCESSED"} 2');
    });

    test("corrida perdida conta em concurrency_conflicts_total", async () => {
        const { registry, useCase } = setup();
        // Mesma key, wallets diferentes, ao mesmo tempo: os locks são de wallets distintas,
        // então as duas tentam inserir e a unique da idempotency key decide quem perde.
        const [a, b] = await Promise.all([newWallet("10.00"), newWallet("10.00")]);
        const key = `provider-a:${Bun.randomUUIDv7()}`;
        await Promise.allSettled([
            useCase.execute({ ...bet(a, "1.00"), idempotencyKey: key }),
            useCase.execute({ ...bet(b, "1.00"), idempotencyKey: key }),
        ]);

        expect(await registry.metrics()).toMatch(/concurrency_conflicts_total\{operation="process_wager_transaction"\} [1-9]/);
    });
});
