import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError, WalletAlreadyExistsError } from "../../src/application/errors";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { InvalidMoneyError } from "../../src/domain/money/money.errors";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";

let orm: MikroORM;
let createWallet: CreateWallet;

beforeAll(async () => {
    orm = await MikroORM.init({ ...config, pool: { min: 2, max: 20 } });
    await orm.migrator.up();
    createWallet = new CreateWallet(new MikroOrmUnitOfWork(orm));
});

afterAll(async () => {
    await orm.close(true);
});

async function rows<T>(sql: string, params: unknown[]): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(sql, params);
}

describe("CreateWallet", () => {
    test("saldo inicial > 0 cria wallet + OPENING + CREDIT na mesma transação", async () => {
        const wallet = await createWallet.execute({
            playerId: Bun.randomUUIDv7(),
            initialBalance: { amount: "1000.00", currency: "BRL" },
        });

        expect(wallet.balance.toString()).toBe("1000.00");
        expect(wallet.version).toBe(1);

        const txs = await rows<{ kind: string; status: string; amount: string }>(
            "select kind, status, amount::text from wager_transactions where wallet_id = ?", [wallet.id],
        );
        expect(txs).toEqual([{ kind: "OPENING", status: "PROCESSED", amount: "1000.00" }]);

        const entries = await rows<{ direction: string; balance_after: string }>(
            "select direction, balance_after::text from wallet_ledger_entries where wallet_id = ?", [wallet.id],
        );
        expect(entries).toEqual([{ direction: "CREDIT", balance_after: "1000.00" }]);
    });

    test("saldo inicial zero não gera OPENING nem ledger", async () => {
        const wallet = await createWallet.execute({
            playerId: Bun.randomUUIDv7(),
            initialBalance: { amount: "0.00", currency: "BRL" },
        });

        const [counts] = await rows<{ txs: number; entries: number }>(
            `select (select count(*)::int from wager_transactions where wallet_id = ?) as txs,
                    (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as entries`,
            [wallet.id, wallet.id],
        );
        expect(counts).toEqual({ txs: 0, entries: 0 });
    });

    test("mesmo player + moeda é conflito; outra moeda pode", async () => {
        const playerId = Bun.randomUUIDv7();
        await createWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } });

        await expect(
            createWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } }),
        ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

        const usd = await createWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "USD" } });
        expect(usd.currency).toBe("USD");
    });

    test("10 criações em paralelo para o mesmo player: só uma wallet", async () => {
        const playerId = Bun.randomUUIDv7();
        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () =>
                createWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" } }),
            ),
        );

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(failures.every((f) => f.reason instanceof WalletAlreadyExistsError)).toBe(true);

        const [count] = await rows<{ n: number }>("select count(*)::int as n from wallets where player_id = ?", [playerId]);
        expect(count?.n).toBe(1);
    });

    test("saldo inicial inválido é recusado", async () => {
        for (const amount of ["-1.00", "10", "1.234", "abc"]) {
            await expect(
                createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } }),
            ).rejects.toBeInstanceOf(InvalidMoneyError);
        }
    });
});

describe("Unit of work com o banco fora do ar", () => {
    test("vira TransientInfrastructureError", async () => {
        const offline = await MikroORM.init({
            ...config,
            clientUrl: "postgresql://wagering:wagering@localhost:5499/wagering",
            connect: false,
        });
        try {
            const useCase = new CreateWallet(new MikroOrmUnitOfWork(offline));
            await expect(
                useCase.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: "1.00", currency: "BRL" } }),
            ).rejects.toBeInstanceOf(TransientInfrastructureError);
        } finally {
            await offline.close(true);
        }
    });
});
