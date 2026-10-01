import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { LogFields, LoggerPort, MetricLabels, MetricsPort } from "../../src/application/ports/observability";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { ProcessWagerTransaction } from "../../src/application/use-cases/process-wager-transaction";
import { ReconcileWallet } from "../../src/application/use-cases/reconcile-wallet";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWallet;
let processTx: ProcessWagerTransaction;

beforeAll(async () => {
    orm = await MikroORM.init({ ...config, pool: { min: 2, max: 20 } });
    await orm.migrator.up();
    uow = new MikroOrmUnitOfWork(orm);
    createWallet = new CreateWallet(uow);
    processTx = new ProcessWagerTransaction(uow);
});

afterAll(async () => {
    await orm.close(true);
});

class Recorder implements LoggerPort, MetricsPort {
    readonly logs: { level: string; message: string; fields?: LogFields }[] = [];
    readonly counters: { name: string; labels?: MetricLabels }[] = [];
    info(message: string, fields?: LogFields) { this.logs.push({ level: "info", message, fields }); }
    warn(message: string, fields?: LogFields) { this.logs.push({ level: "warn", message, fields }); }
    error(message: string, fields?: LogFields) { this.logs.push({ level: "error", message, fields }); }
    increment(name: string, labels?: MetricLabels) { this.counters.push({ name, labels }); }
    observe() { }
    gauge() { }
}

function newWallet(amount = "100.00"): Promise<Wallet> {
    return createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } });
}

function bet(wallet: Wallet, amount = "1.00") {
    const externalTransactionId = Bun.randomUUIDv7();
    return processTx.execute({
        idempotencyKey: `provider-a:${externalTransactionId}`, providerId: "provider-a", externalTransactionId,
        playerId: wallet.playerId, walletId: wallet.id, roundId: "r1", gameId: "g1",
        kind: "BET", money: { amount, currency: "BRL" },
    });
}

describe("ReconcileWallet", () => {
    test("wallet consistente", async () => {
        const wallet = await newWallet();
        await bet(wallet, "25.00");
        const recorder = new Recorder();

        const result = await new ReconcileWallet(uow, { logger: recorder, metrics: recorder }).execute(wallet.id);

        expect(JSON.parse(JSON.stringify(result))).toEqual({
            walletId: wallet.id,
            storedBalance: { amount: "75.00", currency: "BRL" },
            calculatedBalance: { amount: "75.00", currency: "BRL" },
            difference: { amount: "0.00", currency: "BRL" },
            consistent: true,
            checkedEntries: 2,
        });
        expect(recorder.counters).toEqual([{ name: "wallet_reconciliations_total", labels: { result: "consistent" } }]);
        expect(recorder.logs).toHaveLength(0);
    });

    test("divergência: sinaliza, loga, conta na métrica e NÃO corrige", async () => {
        const wallet = await newWallet();
        // Simula corrupção: alguém mexeu no saldo por fora, sem lançamento no ledger.
        await orm.em.getConnection().execute("update wallets set balance = balance + 1.50 where id = ?", [wallet.id]);
        const recorder = new Recorder();

        const result = await new ReconcileWallet(uow, { logger: recorder, metrics: recorder }).execute(wallet.id);

        expect(result?.consistent).toBe(false);
        expect(result?.difference.toString()).toBe("1.50");
        expect(recorder.counters).toEqual([{ name: "wallet_reconciliations_total", labels: { result: "divergent" } }]);
        expect(recorder.logs[0]).toMatchObject({ level: "error", fields: { walletId: wallet.id, difference: "1.50" } });

        const [row] = await orm.em.getConnection().execute<{ balance: string }[]>(
            "select balance::text from wallets where id = ?", [wallet.id],
        );
        expect(row?.balance).toBe("101.50"); // continua divergente: ninguém "consertou" escondido
    });

    test("wallet inexistente: null", async () => {
        expect(await new ReconcileWallet(uow).execute(Bun.randomUUIDv7())).toBeNull();
    });

    test("reconciliar no meio de apostas concorrentes nunca dá divergência falsa", async () => {
        const wallet = await newWallet();
        const reconcile = new ReconcileWallet(uow);

        const work: Promise<unknown>[] = [];
        for (let i = 0; i < 30; i++) {
            work.push(bet(wallet));
            work.push(reconcile.execute(wallet.id));
        }
        const results = await Promise.all(work);

        const reconciliations = results.filter((r): r is { consistent: boolean } => typeof r === "object" && r !== null && "consistent" in r);
        expect(reconciliations).toHaveLength(30);
        expect(reconciliations.every((r) => r.consistent)).toBe(true);
    });
});
