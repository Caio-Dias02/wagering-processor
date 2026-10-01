import { describe, expect, test } from "bun:test";
import {
    WagerTransactionPendingReference,
    WagerTransactionProcessed,
    WagerTransactionRejected,
    WalletBalanceChanged,
} from "../../src/application/messaging/events";
import { InboxMessage } from "../../src/application/messaging/inbox-message";
import type { EventContext } from "../../src/application/messaging/integration-event";
import { OUTBOX_MAX_DELAY_MS, OutboxMessage } from "../../src/application/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/wager-transaction/failure-code";
import { WagerTransaction, WagerTransactionKind as Kind } from "../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

let seq = 0;
const ctx: EventContext = { correlationId: "corr-1", causationId: "msg-1", occurredAt: NOW, newId: () => `id-${++seq}` };

function bet(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
    return WagerTransaction.create({
        id: "tx-1", providerId: "provider-a", externalTransactionId: "ext-1", idempotencyKey: "provider-a:ext-1",
        payloadHash: "h", walletId: "wallet-1", playerId: "player-1", roundId: "r1", gameId: "g1",
        kind: Kind.Bet, money: brl("25.00"), createdAt: NOW, ...overrides,
    });
}

describe("eventos de integração", () => {
    test("envelope segue o contrato e carrega MoneyProps (string), nunca Money", () => {
        const tx = bet();
        tx.markProcessed(undefined, brl("75.00"), NOW);
        const json = WagerTransactionProcessed.from(tx, ctx).toJSON();

        expect(json).toMatchObject({
            eventType: "WagerTransactionProcessed",
            version: 1,
            aggregateId: "tx-1",
            correlationId: "corr-1",
            causationId: "msg-1",
            occurredAt: "2026-10-01T12:00:00.000Z",
        });
        expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
        expect(json.data.observedBalance).toEqual({ amount: "75.00", currency: "BRL" });
        // ida e volta por JSON não perde nada
        expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    });

    test("rejeição carrega o failureCode e não carrega saldo", () => {
        const tx = bet();
        tx.reject(FailureCode.InsufficientFunds, brl("5.00"), NOW);
        const data = WagerTransactionRejected.from(tx, ctx).toJSON().data;
        expect(data.failureCode).toBe("INSUFFICIENT_FUNDS");
        expect(Object.keys(data)).not.toContain("observedBalance");
    });

    test("pendente de referência carrega a referência esperada", () => {
        const tx = bet({ kind: Kind.Refund, referenceExternalTransactionId: "bet-9" });
        tx.markPendingReference();
        expect(WagerTransactionPendingReference.from(tx, ctx).toJSON().data.referenceExternalTransactionId).toBe("bet-9");
    });

    test("WalletBalanceChanged usa o lançamento do ledger e a versão nova da wallet", () => {
        const { wallet } = Wallet.open({
            id: "wallet-1", playerId: "player-1", initialBalance: brl("100.00"),
            openingTransactionId: "op", openingEntryId: "e0", at: NOW,
        });
        const entry = wallet.debit({ entryId: "e1", transactionId: "tx-1", money: brl("25.00"), at: NOW });
        const data = WalletBalanceChanged.from(wallet, entry, ctx).toJSON().data;
        expect(data).toEqual({
            walletId: "wallet-1", transactionId: "tx-1", direction: LedgerDirection.Debit,
            money: { amount: "25.00", currency: "BRL" },
            balanceBefore: { amount: "100.00", currency: "BRL" },
            balanceAfter: { amount: "75.00", currency: "BRL" },
            walletVersion: 2,
        });
    });
});

describe("OutboxMessage", () => {
    function message() {
        const tx = bet();
        tx.markProcessed(undefined, brl("75.00"), NOW);
        return OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx));
    }

    test("nasce pendente, com id = eventId, e já pode ser publicada", () => {
        const m = message();
        expect(m.isPending()).toBe(true);
        expect(m.id).toBe(m.payload.eventId as string);
        expect(m.isDue(NOW)).toBe(true);
    });

    test("backoff exponencial com teto", () => {
        const m = message();
        const delays: number[] = [];
        for (let i = 0; i < 12; i++) {
            m.scheduleRetry(NOW);
            delays.push(m.nextAttemptAt.getTime() - NOW.getTime());
        }
        expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
        expect(delays.at(-1)).toBe(OUTBOX_MAX_DELAY_MS);
        expect(m.attempts).toBe(12);
        expect(m.isDue(NOW)).toBe(false);
    });

    test("publicada deixa de estar pendente; publicar de novo mantém a 1ª data", () => {
        const m = message();
        m.markPublished(NOW);
        m.markPublished(new Date(NOW.getTime() + 1000));
        expect(m.isPending()).toBe(false);
        expect(m.publishedAt).toEqual(NOW);
        expect(m.isDue(new Date(NOW.getTime() + 10_000))).toBe(false);
    });
});

describe("InboxMessage", () => {
    test("recebe não processada e marca uma vez só", () => {
        const m = InboxMessage.receive({ messageId: "m1", consumerName: "c", payloadHash: "h", receivedAt: NOW });
        expect(m.isProcessed()).toBe(false);
        m.markProcessed(NOW);
        m.markProcessed(new Date(NOW.getTime() + 1));
        expect(m.processedAt).toEqual(NOW);
    });
});
