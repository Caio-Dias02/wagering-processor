import { type EntityManager, LockMode, QueryOrder } from "@mikro-orm/postgresql";
import type { PendingReferenceClaim, WagerTransactionRepository } from "../../../application/ports/repositories";
import {
    type WagerTransaction,
    type WagerTransactionKind,
    WagerTransactionStatus,
} from "../../../domain/wager-transaction/wager-transaction";
import { WagerTransactionRecord } from "../entities/wager-transaction.record";
import { WagerTransactionMapper } from "../mappers/wager-transaction.mapper";

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<WagerTransaction | null> {
        return this.findOneBy({ id });
    }

    async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
        return this.findOneBy({ idempotencyKey: key });
    }

    async findByProviderAndExternalId(
        providerId: string,
        externalId: string,
    ): Promise<WagerTransaction | null> {
        return this.findOneBy({ providerId, externalTransactionId: externalId });
    }

    async insert(tx: WagerTransaction): Promise<void> {
        await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx));
    }

    async update(tx: WagerTransaction): Promise<void> {
        await this.em.nativeUpdate(
            WagerTransactionRecord,
            { id: tx.id },
            {
                status: tx.status,
                referenceTransactionId: tx.referenceTransactionId ?? null,
                failureCode: tx.failureCode ?? null,
                observedBalance: tx.observedBalance?.toString() ?? null,
                processedAt: tx.processedAt ?? null,
            },
        );
    }

    async hasProcessedReversal(
        referenceTransactionId: string,
        kind: WagerTransactionKind,
    ): Promise<boolean> {
        const count = await this.em.count(WagerTransactionRecord, {
            referenceTransactionId,
            kind,
            status: WagerTransactionStatus.Processed,
        });
        return count > 0;
    }

    async claimDuePendingReference(now: Date): Promise<PendingReferenceClaim | null> {
        // FOR UPDATE SKIP LOCKED: vários workers dividem as pendentes sem esperar um pelo outro.
        // next_reference_attempt_at nulo = nunca tentada = vencida. Usa o índice parcial.
        const record = await this.em.findOne(
            WagerTransactionRecord,
            {
                status: WagerTransactionStatus.PendingReference,
                $or: [{ nextReferenceAttemptAt: null }, { nextReferenceAttemptAt: { $lte: now } }],
            },
            {
                orderBy: { nextReferenceAttemptAt: QueryOrder.ASC_NULLS_FIRST, createdAt: QueryOrder.ASC },
                lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            },
        );
        return record
            ? { transaction: WagerTransactionMapper.toDomain(record), attempts: record.referenceAttempts }
            : null;
    }

    async scheduleReferenceRetry(transactionId: string, attempts: number, nextAttemptAt: Date): Promise<void> {
        await this.em.nativeUpdate(
            WagerTransactionRecord,
            { id: transactionId },
            { referenceAttempts: attempts, nextReferenceAttemptAt: nextAttemptAt },
        );
    }

    private async findOneBy(
        where: Partial<Pick<WagerTransactionRecord, "id" | "idempotencyKey" | "providerId" | "externalTransactionId">>,
    ): Promise<WagerTransaction | null> {
        const record = await this.em.findOne(WagerTransactionRecord, where);
        return record ? WagerTransactionMapper.toDomain(record) : null;
    }
}