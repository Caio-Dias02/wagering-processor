import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { ReconcileAllWallets, type ReconcileAllWalletsOptions } from "../../src/application/use-cases/reconcile-all-wallets";
import { ReconcileWallet } from "../../src/application/use-cases/reconcile-wallet";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWallet;

beforeAll(async () => {
    orm = await MikroORM.init({ ...config, pool: { min: 2, max: 20 } });
    await orm.migrator.up();
    uow = new MikroOrmUnitOfWork(orm);
    createWallet = new CreateWallet(uow);
});

afterAll(async () => {
    await orm.close(true);
});

function newWallet(): Promise<Wallet> {
    return createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount: "100.00", currency: "BRL" } });
}

/** Para logo no começo: nos testes que só olham quem ganhou a lease, varrer tudo é perda de tempo. */
const stopAtOnce = () => true;

/** Cada teste usa a própria lease: os testes compartilham o banco. */
function sweep(options: Partial<ReconcileAllWalletsOptions> = {}): ReconcileAllWallets {
    return new ReconcileAllWallets(uow, new ReconcileWallet(uow), undefined, {
        jobName: `test-${Bun.randomUUIDv7()}`,
        intervalMs: 60_000,
        batchSize: 200,
        ...options,
    });
}

async function walletCount(): Promise<number> {
    const [row] = await orm.em.getConnection().execute<{ n: number }[]>("select count(*)::int as n from wallets");
    return row!.n;
}

describe("ReconcileAllWallets", () => {
    test("confere todas as wallets (paginando) e aponta as divergentes", async () => {
        const healthy = await newWallet();
        const broken = await newWallet();
        // Simula corrupção: saldo alterado por fora, sem lançamento no ledger.
        await orm.em.getConnection().execute("update wallets set balance = balance + 1.00 where id = ?", [broken.id]);

        // batchSize pequeno: obriga a passar por várias páginas.
        const result = await sweep({ batchSize: 7 }).execute();

        expect(result?.checked).toBe(await walletCount());
        expect(result?.divergent).toContain(broken.id);
        expect(result?.divergent).not.toContain(healthy.id);
        expect(result?.interrupted).toBe(false);
    }, 60_000); // varre o banco inteiro, que os outros testes também enchem

    test("várias instâncias ao mesmo tempo: só uma faz a varredura do ciclo", async () => {
        await newWallet();
        const jobName = `test-${Bun.randomUUIDv7()}`;
        const instances = Array.from({ length: 5 }, () => sweep({ jobName }));

        const results = await Promise.all(instances.map((s) => s.execute(stopAtOnce)));

        expect(results.filter((r) => r !== null)).toHaveLength(1);
        // Ainda no mesmo ciclo: quem chegar depois também pula.
        expect(await instances[0]!.execute(stopAtOnce)).toBeNull();
    });

    test("passado o intervalo, a próxima instância roda de novo", async () => {
        const jobName = `test-${Bun.randomUUIDv7()}`;
        const first = sweep({ jobName, intervalMs: 200 });
        const second = sweep({ jobName, intervalMs: 200 });

        expect(await first.execute(stopAtOnce)).not.toBeNull();
        expect(await second.execute(stopAtOnce)).toBeNull();
        await Bun.sleep(250);
        expect(await second.execute(stopAtOnce)).not.toBeNull();
    });

    test("desligando: para entre uma wallet e outra e avisa que foi interrompida", async () => {
        await newWallet();
        await newWallet();
        let calls = 0;

        const result = await sweep().execute(() => ++calls > 1);

        expect(result?.checked).toBe(1);
        expect(result?.interrupted).toBe(true);
    });
});
