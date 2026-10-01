import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";
import { FailureCode } from "../../src/domain/wager-transaction/failure-code";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wager-transaction/wager-transaction";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../src/domain/wager-transaction/wager-transaction.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const NOW = new Date("2026-09-30T12:00:00.000Z");

function tx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: NOW,
    ...overrides,
  });
}

function processed(t: WagerTransaction): WagerTransaction {
  t.markProcessed(undefined, brl("75.00"), NOW);
  return t;
}

describe("WagerTransaction", () => {
  describe("criação", () => {
    test("nasce em PENDING", () => {
      expect(tx().status).toBe(Status.Pending);
    });

    test("OPENING não pode ser criado por provedor", () => {
      expect(() => tx({ kind: Kind.Opening })).toThrow(InvalidWagerTransactionError);
    });

    test("não pode referenciar a si mesma", () => {
      expect(() => tx({ kind: Kind.Refund, referenceExternalTransactionId: "ext-1" })).toThrow(
        InvalidWagerTransactionError,
      );
    });

    test("provedor não pode se passar pelo provider interno", () => {
      expect(() => tx({ providerId: "internal" })).toThrow(InvalidWagerTransactionError);
    });

    test("REFUND e ROLLBACK exigem referência", () => {
      expect(() => tx({ kind: Kind.Refund })).toThrow(InvalidWagerTransactionError);
      expect(() => tx({ kind: Kind.Rollback })).toThrow(InvalidWagerTransactionError);
    });

    test("BET não pode ter referência", () => {
      expect(() => tx({ referenceExternalTransactionId: "ext-0" })).toThrow(InvalidWagerTransactionError);
    });

    test("BET com valor zero é inválida, LOSS com zero é aceita", () => {
      expect(() => tx({ money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
      expect(tx({ kind: Kind.Loss, money: brl("0.00") }).status).toBe(Status.Pending);
    });

    test("campos obrigatórios vazios são rejeitados", () => {
      expect(() => tx({ roundId: "  " })).toThrow(InvalidWagerTransactionError);
    });

    test("createOpening nasce PROCESSED", () => {
      const opening = WagerTransaction.createOpening({
        id: "tx-open", walletId: "wallet-1", playerId: "player-1", money: brl("100.00"), createdAt: NOW,
      });
      expect(opening.kind).toBe(Kind.Opening);
      expect(opening.status).toBe(Status.Processed);
    });
  });

  describe("transições", () => {
    test("PENDING → PROCESSED guarda o saldo observado", () => {
      const t = processed(tx());
      expect(t.status).toBe(Status.Processed);
      expect(t.isTerminal()).toBe(true);
      expect(t.observedBalance?.toString()).toBe("75.00");
    });

    test("estados terminais não mudam mais", () => {
      const t = processed(tx());
      expect(() => t.reject(FailureCode.InsufficientFunds, undefined, NOW)).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.InfrastructureFailure, NOW)).toThrow(InvalidTransactionStateError);
      expect(() => t.markProcessed(undefined, brl("1.00"), NOW)).toThrow(InvalidTransactionStateError);
      expect(t.status).toBe(Status.Processed);
    });

    test("PENDING → PENDING_REFERENCE → PROCESSED", () => {
      const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: "ext-0" });
      t.markPendingReference();
      expect(t.status).toBe(Status.PendingReference);
      expect(t.isTerminal()).toBe(false);

      t.markProcessed("tx-0", brl("100.00"), NOW);
      expect(t.status).toBe(Status.Processed);
      expect(t.referenceTransactionId).toBe("tx-0");
    });

    test("PENDING_REFERENCE só pode vir de PENDING", () => {
      const t = processed(tx());
      expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    });

    test("reject registra o failureCode", () => {
      const t = tx();
      t.reject(FailureCode.InsufficientFunds, brl("10.00"), NOW);
      expect(t.status).toBe(Status.Rejected);
      expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    });
  });

  describe("consultas", () => {
    test("LOSS não afeta saldo", () => {
      expect(tx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
      expect(tx().affectsBalance()).toBe(true);
    });

    test("matchesPayload compara o hash", () => {
      expect(tx().matchesPayload("hash-1")).toBe(true);
      expect(tx().matchesPayload("outro-hash")).toBe(false);
    });
  });

  describe("direção no ledger", () => {
    const bet = processed(tx());
    const win = processed(tx({ id: "tx-w", externalTransactionId: "ext-w", kind: Kind.Win }));

    test("BET debita; WIN e REFUND creditam", () => {
      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(tx({ externalTransactionId: "ext-r", kind: Kind.Refund, referenceExternalTransactionId: "ext-1" }).ledgerDirectionFor())
        .toBe(LedgerDirection.Credit);
    });

    test("ROLLBACK é o inverso da referência", () => {
      const rollback = tx({ id: "tx-r", externalTransactionId: "ext-r", kind: Kind.Rollback, referenceExternalTransactionId: "ext-1" });
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    });

    test("LOSS não tem direção", () => {
      expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    });
  });

  describe("validação da referência", () => {
    const bet = processed(tx());
    const refund = (o: Partial<CreateWagerTransactionProps> = {}) =>
      tx({ id: "tx-2", externalTransactionId: "ext-2", kind: Kind.Refund, referenceExternalTransactionId: "ext-1", ...o });

    test("REFUND válido de uma BET processada", () => {
      expect(refund().checkReference(bet)).toBeUndefined();
    });

    test("rodada diferente é mismatch", () => {
      expect(refund({ roundId: "round-2" }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    });

    test("REFUND não pode referenciar WIN", () => {
      const win = processed(tx({ id: "tx-w", externalTransactionId: "ext-w", kind: Kind.Win }));
      expect(refund().checkReference(win)).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    test("ROLLBACK não pode referenciar outro ROLLBACK", () => {
      const rb1 = processed(tx({ id: "tx-r1", externalTransactionId: "ext-r1", kind: Kind.Rollback, referenceExternalTransactionId: "ext-1" }));
      const rb2 = tx({ id: "tx-r2", externalTransactionId: "ext-r2", kind: Kind.Rollback, referenceExternalTransactionId: "ext-r1" });
      expect(rb2.checkReference(rb1)).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    test("valor diferente da referência é rejeitado", () => {
      expect(refund({ money: brl("10.00") }).checkReference(bet)).toBe(FailureCode.ReferenceAmountMismatch);
    });

    test("referência rejeitada não pode ser revertida", () => {
      const rejectedBet = tx();
      rejectedBet.reject(FailureCode.InsufficientFunds, undefined, NOW);
      expect(refund().checkReference(rejectedBet)).toBe(FailureCode.ReferenceNotProcessed);
    });
  });
});