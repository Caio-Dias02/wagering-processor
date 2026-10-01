import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { IdempotencyConflictError, WalletNotFoundError } from "../../src/application/errors";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import {
    ProcessWagerTransaction,
    type ProcessWagerTransactionCommand,
} from "../../src/application/use-cases/process-wager-transaction";
import { FailureCode } from "../../src/domain/wager-transaction/failure-code";
import { WagerTransactionStatus as Status } from "../../src/domain/wager-transaction/wager-transaction";
import { InvalidWagerTransactionError } from "../../src/domain/wager-transaction/wager-transaction.errors";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let useCase: ProcessWagerTransaction;
let walletFactory: CreateWallet;

beforeAll(async () => {
    orm = await MikroORM.init({ ...config, pool: { min: 2, max: 20 } });
    await orm.migrator.up();
    uow = new MikroOrmUnitOfWork(orm);
    useCase = new ProcessWagerTransaction(uow);
    walletFactory = new CreateWallet(uow);
});

afterAll(async () => {
    await orm.close(true);
});

function createWallet(amount: string, currency = "BRL"): Promise<Wallet> {
    return walletFactory.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency } });
}

/** Monta um comando válido; `overrides` troca só o que o teste quer. */
function command(
    wallet: Wallet,
    overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
    const externalTransactionId = overrides.externalTransactionId ?? Bun.randomUUIDv7();
    return {
        idempotencyKey: `provider-a:${externalTransactionId}`,
        providerId: "provider-a",
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "10.00", currency: wallet.currency },
        ...overrides,
    };
}

async function balanceOf(walletId: string): Promise<string> {
    const wallet = await uow.run((ctx) => ctx.wallets.findById(walletId));
    return wallet!.balance.toString();
}

/** Saldo reconstruído somando o ledger inteiro, direto no SQL. */
async function ledgerBalanceOf(walletId: string): Promise<string> {
    const [row] = await orm.em.getConnection().execute<{ total: string }[]>(
        `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as total
           from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
    );
    return row!.total;
}

async function countLedger(walletId: string, direction: "DEBIT" | "CREDIT"): Promise<number> {
    const [row] = await orm.em.getConnection().execute<{ n: number }[]>(
        "select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = ?",
        [walletId, direction],
    );
    return row!.n;
}

/** Invariante final de todos os testes: saldo == ledger. */
async function expectConsistent(walletId: string, expectedBalance: string) {
    expect(await balanceOf(walletId)).toBe(expectedBalance);
    expect(await ledgerBalanceOf(walletId)).toBe(expectedBalance);
}

describe("ProcessWagerTransaction: regras", () => {
    test("BET debita e devolve o saldo novo", async () => {
        const wallet = await createWallet("100.00");
        const result = await useCase.execute(command(wallet, { money: { amount: "25.00", currency: "BRL" } }));

        expect(result.status).toBe(Status.Processed);
        expect(result.balance?.toString()).toBe("75.00");
        expect(result.idempotentReplay).toBe(false);
        await expectConsistent(wallet.id, "75.00");
    });

    test("BET sem saldo é rejeitada, sem ledger", async () => {
        const wallet = await createWallet("5.00");
        const result = await useCase.execute(command(wallet));

        expect(result.status).toBe(Status.Rejected);
        expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
        expect(await countLedger(wallet.id, "DEBIT")).toBe(0);
        await expectConsistent(wallet.id, "5.00");
    });

    test("WIN credita; LOSS não mexe no saldo nem no ledger", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        const win = await useCase.execute(command(wallet, {
            kind: "WIN", money: { amount: "30.00", currency: "BRL" },
            referenceExternalTransactionId: bet.externalTransactionId,
        }));
        expect(win.status).toBe(Status.Processed);
        expect(win.balance?.toString()).toBe("120.00");

        const loss = await useCase.execute(command(wallet, { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }));
        expect(loss.status).toBe(Status.Processed);
        expect(loss.balance?.toString()).toBe("120.00");

        expect(await countLedger(wallet.id, "CREDIT")).toBe(2); // OPENING + WIN
        await expectConsistent(wallet.id, "120.00");
    });

    test("REFUND devolve a BET uma única vez", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        const refund = await useCase.execute(command(wallet, {
            kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId,
        }));
        expect(refund.status).toBe(Status.Processed);
        expect(refund.balance?.toString()).toBe("100.00");

        // outro REFUND (outro externalTransactionId) da mesma BET
        const second = await useCase.execute(command(wallet, {
            kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId,
        }));
        expect(second.status).toBe(Status.Rejected);
        expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
        await expectConsistent(wallet.id, "100.00");
    });

    test("REFUND depois de ROLLBACK da mesma BET é rejeitado (sem crédito duplo)", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);
        await useCase.execute(command(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: bet.externalTransactionId }));

        const refund = await useCase.execute(command(wallet, {
            kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId,
        }));
        expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
        await expectConsistent(wallet.id, "100.00");
    });

    test("WIN e LOSS não liquidam uma BET já revertida", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);
        await useCase.execute(command(wallet, { kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId }));

        for (const kind of ["WIN", "LOSS"]) {
            const result = await useCase.execute(command(wallet, {
                kind, referenceExternalTransactionId: bet.externalTransactionId,
            }));
            expect(result.status).toBe(Status.Rejected);
            expect(result.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
        }
        await expectConsistent(wallet.id, "100.00");
    });

    test("crédito que passaria do limite do saldo é rejeitado (e não vira 500)", async () => {
        const wallet = await createWallet("99999999999999999.00");
        const result = await useCase.execute(command(wallet, { kind: "WIN", money: { amount: "1.00", currency: "BRL" } }));

        expect(result.status).toBe(Status.Rejected);
        expect(result.failureCode).toBe(FailureCode.BalanceLimitExceeded);
        await expectConsistent(wallet.id, "99999999999999999.00");
    });

    test("ROLLBACK de WIN debita; sem saldo vira REVERSAL_INSUFFICIENT_FUNDS", async () => {
        const wallet = await createWallet("10.00");
        const bet = command(wallet);
        await useCase.execute(bet); // saldo 0.00
        const win = command(wallet, {
            kind: "WIN", money: { amount: "50.00", currency: "BRL" },
            referenceExternalTransactionId: bet.externalTransactionId,
        });
        await useCase.execute(win); // saldo 50.00
        await useCase.execute(command(wallet, { money: { amount: "45.00", currency: "BRL" } })); // saldo 5.00

        const rollback = await useCase.execute(command(wallet, {
            kind: "ROLLBACK", money: { amount: "50.00", currency: "BRL" },
            referenceExternalTransactionId: win.externalTransactionId,
        }));
        expect(rollback.status).toBe(Status.Rejected);
        expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
        await expectConsistent(wallet.id, "5.00");
    });

    test("REFUND com valor diferente da BET é rejeitado", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        const refund = await useCase.execute(command(wallet, {
            kind: "REFUND", money: { amount: "9.99", currency: "BRL" },
            referenceExternalTransactionId: bet.externalTransactionId,
        }));
        expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
        await expectConsistent(wallet.id, "90.00");
    });

    test("REFUND antes da BET fica PENDING_REFERENCE", async () => {
        const wallet = await createWallet("100.00");
        const result = await useCase.execute(command(wallet, {
            kind: "REFUND", referenceExternalTransactionId: "bet-que-ainda-nao-chegou",
        }));

        expect(result.status).toBe(Status.PendingReference);
        expect(result.balance).toBeUndefined();
        await expectConsistent(wallet.id, "100.00");
    });

    test("moeda diferente da wallet é rejeitada, e o replay não inventa saldo em outra moeda", async () => {
        const wallet = await createWallet("100.00");
        const usdBet = command(wallet, { money: { amount: "10.00", currency: "USD" } });
        const result = await useCase.execute(usdBet);

        expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
        expect(result.balance).toBeUndefined();
        const replay = await useCase.execute(usdBet);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.balance).toBeUndefined();
        await expectConsistent(wallet.id, "100.00");
    });

    test("wallet de outro jogador é rejeitada sem expor o saldo", async () => {
        const wallet = await createWallet("100.00");
        const result = await useCase.execute(command(wallet, { playerId: Bun.randomUUIDv7() }));

        expect(result.failureCode).toBe(FailureCode.WalletOwnershipMismatch);
        expect(result.balance).toBeUndefined();
        await expectConsistent(wallet.id, "100.00");
    });

    test("wallet inexistente lança WalletNotFoundError", async () => {
        const wallet = await createWallet("100.00");
        const ghost = command(wallet, { walletId: Bun.randomUUIDv7() });
        await expect(useCase.execute(ghost)).rejects.toBeInstanceOf(WalletNotFoundError);
    });

    test("payload inválido nem chega no banco", async () => {
        const wallet = await createWallet("100.00");
        await expect(useCase.execute(command(wallet, { kind: "OPENING" }))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
        await expect(useCase.execute(command(wallet, { kind: "JACKPOT" }))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
        await expect(useCase.execute(command(wallet, { money: { amount: "1e3", currency: "BRL" } }))).rejects.toThrow();
    });
});

describe("ProcessWagerTransaction: idempotência", () => {
    test("replay devolve o resultado ORIGINAL, mesmo com o saldo já diferente", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        const first = await useCase.execute(bet);
        await useCase.execute(command(wallet)); // outra aposta muda o saldo para 80.00

        const replay = await useCase.execute(bet);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.transactionId).toBe(first.transactionId);
        expect(replay.balance?.toString()).toBe("90.00");
        await expectConsistent(wallet.id, "80.00");
    });

    test("replay de rejeição continua rejeição", async () => {
        const wallet = await createWallet("5.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        const replay = await useCase.execute(bet);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    test("mesma key com payload diferente é conflito", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        const tampered = { ...bet, money: { amount: "99.00", currency: "BRL" } };
        await expect(useCase.execute(tampered)).rejects.toBeInstanceOf(IdempotencyConflictError);
        await expectConsistent(wallet.id, "90.00");
    });

    test("key reaproveitada apontando para wallet inexistente é conflito, não WALLET_NOT_FOUND", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        await expect(useCase.execute({ ...bet, walletId: Bun.randomUUIDv7() })).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    test("mesmo externalTransactionId com outra key é conflito", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);
        await useCase.execute(bet);

        await expect(useCase.execute({ ...bet, idempotencyKey: "outra-key" })).rejects.toBeInstanceOf(IdempotencyConflictError);
    });
});

describe("ProcessWagerTransaction: concorrência", () => {
    test("a mesma aposta 50x em paralelo gera um único débito", async () => {
        const wallet = await createWallet("100.00");
        const bet = command(wallet);

        const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(bet)));

        expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
        expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
        expect(results.every((r) => r.balance?.toString() === "90.00")).toBe(true);
        expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
        await expectConsistent(wallet.id, "90.00");
    });

    test("saldo 100, duas apostas de 80 em paralelo: uma passa, outra é rejeitada", async () => {
        const wallet = await createWallet("100.00");
        const eighty = { amount: "80.00", currency: "BRL" };

        const results = await Promise.all([
            useCase.execute(command(wallet, { money: eighty })),
            useCase.execute(command(wallet, { money: eighty })),
        ]);

        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([Status.Processed, Status.Rejected]);
        expect(results.find((r) => r.status === Status.Rejected)?.failureCode).toBe(FailureCode.InsufficientFunds);
        expect(await countLedger(wallet.id, "DEBIT")).toBe(1);
        await expectConsistent(wallet.id, "20.00");
    });

    test("wallets diferentes em paralelo não interferem entre si", async () => {
        const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet("100.00")));

        await Promise.all(
            wallets.flatMap((w) => Array.from({ length: 4 }, () => useCase.execute(command(w)))),
        );

        for (const w of wallets) await expectConsistent(w.id, "60.00");
    });
});
