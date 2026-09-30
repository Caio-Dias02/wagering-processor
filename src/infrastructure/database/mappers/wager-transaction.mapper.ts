import { Money } from "../../../domain/money/money";
import type { FailureCode } from "../../../domain/wager-transaction/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../../domain/wager-transaction/wager-transaction";
import type { WagerTransactionRecord } from "../entities/wager-transaction.record";

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: Money.rehydrate({ amount: r.amount, currency: r.currency }),
      referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.referenceTransactionId ?? undefined,
      failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
      observedBalance: r.observedBalance
        ? Money.rehydrate({ amount: r.observedBalance, currency: r.currency })
        : undefined,
      processedAt: r.processedAt ?? undefined,
    });
  },

  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.toString(),
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      observedBalance: t.observedBalance?.toString() ?? null,
      referenceAttempts: 0,
      nextReferenceAttemptAt: null,
      createdAt: t.createdAt,
      processedAt: t.processedAt ?? null,
    };
  },
};