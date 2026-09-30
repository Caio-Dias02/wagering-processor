import type { EntityManager } from "@mikro-orm/postgresql";
import type { LedgerPage, LedgerRepository } from "../../../application/ports/repositories";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { WalletLedgerEntryRecord } from "../entities/wallet-ledger-entry.record";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";

export class MikroOrmLedgerRepository implements LedgerRepository {
    constructor(private readonly em: EntityManager) { }

    async insert(entry: WalletLedgerEntry): Promise<void> {
        await this.em.insert(WalletLedgerEntryRecord, WalletLedgerEntryMapper.toRecord(entry));
    }

    async listByWallet(
        walletId: string,
        afterCursor: string | undefined,
        limit: number,
    ): Promise<LedgerPage> {
        const records = await this.em.find(
            WalletLedgerEntryRecord,
            afterCursor ? { walletId, seq: { $gt: afterCursor } } : { walletId },
            { orderBy: { seq: "asc" }, limit: limit + 1 },
        );

        const hasMore = records.length > limit;
        const page = hasMore ? records.slice(0, limit) : records;
        const last = page.at(-1);

        return {
            entries: page.map(WalletLedgerEntryMapper.toDomain),
            nextCursor: hasMore && last ? last.seq : undefined,
        };
    }
}