import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import {
    ProcessWagerTransaction,
    type ProcessWagerTransactionCommand,
} from "../../src/application/use-cases/process-wager-transaction";
import {
    type PendingReferencePolicy,
    ResolvePendingReference,
} from "../../src/application/use-cases/resolve-pending-reference";
import { FailureCode } from "../../src/domain/wager-transaction/failure-code";
import { WagerTransactionStatus } from "../../src/domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../src/domain/wallet/wallet";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/mikro-orm-unit-of-work";

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let processTx: ProcessWagerTransaction;
let createWallet: CreateWallet;

/** Sem espera entre tentativas, para o teste não depender do relógio. */
const IMMEDIATE: PendingReferencePolicy = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

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

// Banco compartilhado: pendentes de outros testes vão para o futuro distante, para o
// resolver deste teste só enxergar as que o próprio teste criou.
beforeEach(async () => {
    await sql(
        `update wager_transactions set next_reference_attempt_at = now() + interval '10 years'
          where status = 'PENDING_REFERENCE'`,
    );
});

function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    return orm.em.getConnection().execute<T[]>(query, params);
}

function newWallet(amount = "100.00"): Promise<Wallet> {
    return createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: "BRL" } });
}

function command(wallet: Wallet, overrides: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand {
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
        money: { amount: "10.00", currency: "BRL" },
        ...overrides,
    };
}

async function transaction(id: string) {
    const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number }>(
        "select status, failure_code, reference_attempts from wager_transactions where id = ?", [id],
    );
    return row!;
}

async function balanceOf(walletId: string) {
    const [row] = await sql<{ balance: string; ledger: string }>(
        `select w.balance::text,
                (select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text
                   from wallet_ledger_entries where wallet_id = w.id) as ledger
           from wallets w where w.id = ?`,
        [walletId],
    );
    expect(row!.ledger).toBe(row!.balance); // invariante: saldo == ledger
    return row!.balance;
}

async function drain(resolver: ResolvePendingReference) {
    for (let i = 0; i < 100 && (await resolver.execute()) !== "none"; i++) { /* próxima */ }
}

describe("worker de PENDING_REFERENCE", () => {
    test("REFUND chega antes da BET: fica pendente e é aplicado quando a BET chega", async () => {
        const wallet = await newWallet();
        const betId = Bun.randomUUIDv7();
        const refund = await processTx.execute(command(wallet, { kind: "REFUND", referenceExternalTransactionId: betId }));
        expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

        await processTx.execute(command(wallet, { externalTransactionId: betId })); // a BET chega: 90.00
        expect(await balanceOf(wallet.id)).toBe("90.00");

        await drain(new ResolvePendingReference(uow, IMMEDIATE));

        expect(await transaction(refund.transactionId)).toMatchObject({ status: "PROCESSED", failure_code: null });
        expect(await balanceOf(wallet.id)).toBe("100.00");
        const events = await sql<{ event_type: string }>(
            "select event_type from outbox_messages where aggregate_id in (?, ?) order by seq",
            [refund.transactionId, wallet.id],
        );
        expect(events.map((e) => e.event_type)).toEqual([
            "WalletBalanceChanged", // abertura
            "WagerTransactionPendingReference",
            "WalletBalanceChanged", // BET
            "WagerTransactionProcessed", // REFUND resolvido
            "WalletBalanceChanged", // REFUND resolvido
        ]);
    });

    test("referência que nunca chega: novas tentativas e, no limite, REJECTED REFERENCE_NOT_FOUND com evento", async () => {
        const wallet = await newWallet();
        const refund = await processTx.execute(command(wallet, {
            kind: "ROLLBACK", referenceExternalTransactionId: "nunca-vai-chegar",
        }));
        const resolver = new ResolvePendingReference(uow, IMMEDIATE);

        expect(await resolver.execute()).toBe("rescheduled");
        expect((await transaction(refund.transactionId)).reference_attempts).toBe(1);
        expect(await resolver.execute()).toBe("rescheduled");
        expect(await resolver.execute()).toBe("expired");

        expect(await transaction(refund.transactionId)).toMatchObject({
            status: "REJECTED", failure_code: FailureCode.ReferenceNotFound,
        });
        const [event] = await sql<{ event_type: string; failure: string }>(
            `select event_type, payload->'data'->>'failureCode' as failure
               from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'`,
            [refund.transactionId],
        );
        expect(event).toEqual({ event_type: "WagerTransactionRejected", failure: "REFERENCE_NOT_FOUND" });
        expect(await balanceOf(wallet.id)).toBe("100.00");
    });

    test("backoff exponencial: a próxima tentativa só vence depois do atraso", async () => {
        const wallet = await newWallet();
        const pending = await processTx.execute(command(wallet, { kind: "REFUND", referenceExternalTransactionId: "x" }));
        let now = new Date("2030-01-01T00:00:00.000Z");
        const resolver = new ResolvePendingReference(
            uow, { maxAttempts: 8, baseDelayMs: 5_000, maxDelayMs: 60_000 }, undefined, undefined, () => now,
        );

        expect(await resolver.execute()).toBe("rescheduled"); // tentativa 1 → próxima em 5s
        now = new Date(now.getTime() + 4_999);
        expect(await resolver.execute()).toBe("none");
        now = new Date(now.getTime() + 1);
        expect(await resolver.execute()).toBe("rescheduled"); // tentativa 2 → próxima em 10s

        const [row] = await sql<{ delay_ms: number }>(
            `select (extract(epoch from next_reference_attempt_at) * 1000)::float8 - ? as delay_ms
               from wager_transactions where id = ?`,
            [now.getTime(), pending.transactionId],
        );
        expect(Math.round(row!.delay_ms)).toBe(10_000);
    });

    test("as regras são reavaliadas na hora: BET revertida enquanto o REFUND esperava é rejeitada", async () => {
        const wallet = await newWallet();
        const betId = Bun.randomUUIDv7();
        const refund = await processTx.execute(command(wallet, { kind: "REFUND", referenceExternalTransactionId: betId }));
        await processTx.execute(command(wallet, { externalTransactionId: betId }));
        await processTx.execute(command(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: betId }));

        await drain(new ResolvePendingReference(uow, IMMEDIATE));

        expect(await transaction(refund.transactionId)).toMatchObject({
            status: "REJECTED", failure_code: FailureCode.ReferenceAlreadyReversed,
        });
        expect(await balanceOf(wallet.id)).toBe("100.00"); // sem crédito duplo
    });

    test("dois workers em paralelo: cada pendente resolvida uma única vez", async () => {
        const wallets = await Promise.all(Array.from({ length: 3 }, () => newWallet()));
        for (const wallet of wallets) {
            for (let i = 0; i < 4; i++) {
                const betId = Bun.randomUUIDv7();
                await processTx.execute(command(wallet, { kind: "REFUND", referenceExternalTransactionId: betId }));
                await processTx.execute(command(wallet, { externalTransactionId: betId }));
            }
        }
        for (const wallet of wallets) expect(await balanceOf(wallet.id)).toBe("60.00");

        let resolvedByA = 0;
        let resolvedByB = 0;
        const run = async (count: () => void) => {
            const resolver = new ResolvePendingReference(uow, IMMEDIATE);
            for (let outcome = await resolver.execute(); outcome !== "none"; outcome = await resolver.execute()) {
                if (outcome === "resolved") count();
            }
        };
        await Promise.all([run(() => resolvedByA++), run(() => resolvedByB++)]);

        expect(resolvedByA + resolvedByB).toBe(12);
        for (const wallet of wallets) expect(await balanceOf(wallet.id)).toBe("100.00");
    });

    test("replay de uma pendente durante a resolução: só leitura, sem deadlock", async () => {
        // O worker trava pendente → wallet. Se o replay pela API atualizasse a pendente
        // (wallet → pendente), as ordens se cruzariam e o Postgres abortaria uma das duas
        // com deadlock_detected, e algum execute() abaixo lançaria erro.
        const wallet = await newWallet();
        const refunds: ProcessWagerTransactionCommand[] = [];
        for (let i = 0; i < 5; i++) {
            const betId = Bun.randomUUIDv7();
            const refund = command(wallet, { kind: "REFUND", referenceExternalTransactionId: betId });
            await processTx.execute(refund);
            await processTx.execute(command(wallet, { externalTransactionId: betId }));
            refunds.push(refund);
        }
        const ids = new Map<string, string>();
        for (const refund of refunds) ids.set(refund.idempotencyKey, (await processTx.execute(refund)).transactionId);

        const drainAll = async () => {
            const resolver = new ResolvePendingReference(uow, IMMEDIATE);
            while ((await resolver.execute()) !== "none") { /* próxima */ }
        };
        const replays = refunds.flatMap((r) => Array.from({ length: 10 }, () => processTx.execute(r)));
        const [results] = await Promise.all([Promise.all(replays), drainAll(), drainAll()]);

        for (const [i, result] of results.entries()) {
            expect(result.idempotentReplay).toBe(true);
            expect(result.transactionId).toBe(ids.get(refunds[Math.floor(i / 10)]!.idempotencyKey)!);
            expect([WagerTransactionStatus.PendingReference, WagerTransactionStatus.Processed]).toContain(result.status);
        }
        for (const id of ids.values()) expect((await transaction(id)).status).toBe("PROCESSED");
        expect(await balanceOf(wallet.id)).toBe("100.00");
    });
});
