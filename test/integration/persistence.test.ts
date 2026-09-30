import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money/money";
import { WagerTransaction } from "../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";

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

function newWallet(amount: string) {
    const now = new Date();
    const walletId = Bun.randomUUIDv7();
    const playerId = Bun.randomUUIDv7();
    const money = Money.from({ amount, currency: "BRL" });
    const opening = WagerTransaction.createOpening({
        id: Bun.randomUUIDv7(), walletId, playerId, money, createdAt: now,
    });
    const { wallet, openingEntry } = Wallet.open({
        id: walletId, playerId, initialBalance: money,
        openingTransactionId: opening.id, openingEntryId: Bun.randomUUIDv7(), at: now,
    });
    return { wallet, opening, openingEntry: openingEntry! };
}

describe("persistência", () => {
    test("salva wallet + OPENING + ledger juntos e reidrata", async () => {
        const { wallet, opening, openingEntry } = newWallet("100.00");

        await uow.run(async (ctx) => {
            await ctx.wallets.insert(wallet);
            await ctx.transactions.insert(opening);
            await ctx.ledger.insert(openingEntry);
        });

        const loaded = await uow.run((ctx) => ctx.wallets.findById(wallet.id));
        expect(loaded?.balance.toString()).toBe("100.00");
        expect(loaded?.version).toBe(1);

        const page = await uow.run((ctx) => ctx.ledger.listByWallet(wallet.id, undefined, 50));
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]?.balanceAfter.toString()).toBe("100.00");
    });

    test("se algo falha no meio, nada é salvo (rollback)", async () => {
        const { wallet } = newWallet("50.00");

        await expect(
            uow.run(async (ctx) => {
                await ctx.wallets.insert(wallet);
                throw new Error("explodiu no meio");
            }),
        ).rejects.toThrow("explodiu no meio");

        const loaded = await uow.run((ctx) => ctx.wallets.findById(wallet.id));
        expect(loaded).toBeNull();
    });

    test("o banco recusa editar o ledger (append-only)", async () => {
        const { wallet, opening, openingEntry } = newWallet("10.00");
        await uow.run(async (ctx) => {
            await ctx.wallets.insert(wallet);
            await ctx.transactions.insert(opening);
            await ctx.ledger.insert(openingEntry);
        });

        const connection = orm.em.getConnection();
        await expect(
            connection.execute("update wallet_ledger_entries set created_at = now() where id = ?", [openingEntry.id]),
        ).rejects.toThrow();
        await expect(
            connection.execute("delete from wallet_ledger_entries where id = ?", [openingEntry.id]),
        ).rejects.toThrow();
    });

    test("o banco recusa idempotency_key duplicada", async () => {
        const a = newWallet("10.00");
        await uow.run(async (ctx) => {
            await ctx.wallets.insert(a.wallet);
            await ctx.transactions.insert(a.opening);
        });

        // outra OPENING para a MESMA wallet gera a mesma idempotency key
        const duplicate = WagerTransaction.createOpening({
            id: Bun.randomUUIDv7(),
            walletId: a.wallet.id,
            playerId: a.wallet.playerId,
            money: Money.from({ amount: "10.00", currency: "BRL" }),
            createdAt: new Date(),
        });

        await expect(uow.run((ctx) => ctx.transactions.insert(duplicate))).rejects.toThrow();
    });

    test("save com version desatualizada é recusado", async () => {
        const { wallet } = newWallet("100.00");
        await uow.run((ctx) => ctx.wallets.insert(wallet));

        await expect(
            uow.run(async (ctx) => {
                const w = (await ctx.wallets.findByIdForUpdate(wallet.id))!;
                w.debit({
                    entryId: Bun.randomUUIDv7(), transactionId: Bun.randomUUIDv7(),
                    money: Money.from({ amount: "10.00", currency: "BRL" }), at: new Date(),
                });
                await ctx.wallets.save(w, 999); // version errada de propósito
            }),
        ).rejects.toThrow("changed concurrently");
    });
});