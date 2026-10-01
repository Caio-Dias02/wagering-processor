import type { EntityManager } from "@mikro-orm/postgresql";
import type { LedgerPage, LedgerRepository, ReconciliationSnapshot } from "../../../application/ports/repositories";
import { Money } from "../../../domain/money/money";
import type { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { WalletLedgerEntryRecord } from "../entities/wallet-ledger-entry.record";
import { WalletLedgerEntryMapper } from "../mappers/wallet-ledger-entry.mapper";

interface SnapshotRow {
    currency: string;
    stored: string;
    calculated: string;
    entries: number;
}

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

    async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
        // Uma instrução só = um snapshot só: um lançamento commitado no meio não cria
        // divergência falsa. A soma é feita em numeric no banco e volta como texto exato.
        const [row] = await this.em.getConnection().execute<SnapshotRow[]>(
            `select w.currency,
                    w.balance::text as stored,
                    coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as calculated,
                    count(l.id)::int as entries
               from wallets w
               left join wallet_ledger_entries l on l.wallet_id = w.id
              where w.id = ?
              group by w.id`,
            [walletId],
            "all",
            this.em.getTransactionContext(),
        );
        if (!row) return null;

        const money = (amount: string) => Money.rehydrate({ amount, currency: row.currency });
        return { storedBalance: money(row.stored), calculatedBalance: money(row.calculated), checkedEntries: row.entries };
    }
}