import type { EntityManager } from "@mikro-orm/postgresql";
import type { WagerTransactionRepository } from "../../../application/ports/repositories";
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

    private async findOneBy(
        where: Partial<Pick<WagerTransactionRecord, "id" | "idempotencyKey" | "providerId" | "externalTransactionId">>,
    ): Promise<WagerTransaction | null> {
        const record = await this.em.findOne(WagerTransactionRecord, where);
        return record ? WagerTransactionMapper.toDomain(record) : null;
    }
}