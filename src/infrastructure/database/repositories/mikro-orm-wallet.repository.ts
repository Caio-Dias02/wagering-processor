import { type EntityManager, LockMode } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../../application/errors";
import type { WalletRepository } from "../../../application/ports/repositories";
import type { Wallet } from "../../../domain/wallet/wallet";
import { WalletRecord } from "../entities/wallet.record";
import { WalletMapper } from "../mappers/wallet.mapper";

export class MikroOrmWalletRepository implements WalletRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<Wallet | null> {
        const record = await this.em.findOne(WalletRecord, { id });
        return record ? WalletMapper.toDomain(record) : null;
    }

    async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
        const record = await this.em.findOne(WalletRecord, { playerId, currency });
        return record ? WalletMapper.toDomain(record) : null;
    }

    async findByIdForUpdate(id: string): Promise<Wallet | null> {
        const record = await this.em.findOne(
            WalletRecord,
            { id },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        return record ? WalletMapper.toDomain(record) : null;
    }

    async listIds(afterId: string | undefined, limit: number): Promise<string[]> {
        const records = await this.em.find(
            WalletRecord,
            afterId ? { id: { $gt: afterId } } : {},
            { orderBy: { id: "asc" }, limit, fields: ["id"] },
        );
        return records.map((r) => r.id);
    }

    async insert(wallet: Wallet): Promise<void> {
        await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    }

    async save(wallet: Wallet, expectedVersion: number): Promise<void> {
        const affected = await this.em.nativeUpdate(
            WalletRecord,
            { id: wallet.id, version: expectedVersion },
            {
                balance: wallet.balance.toString(),
                version: wallet.version,
                updatedAt: wallet.updatedAt,
            },
        );
        if (affected !== 1) {
            throw new ConcurrencyConflictError(`Wallet ${wallet.id} changed concurrently`);
        }
    }
}