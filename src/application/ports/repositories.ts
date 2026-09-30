import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type {
    WagerTransaction,
    WagerTransactionKind,
} from "../../domain/wager-transaction/wager-transaction";

export interface WalletRepository {
    findById(id: string): Promise<Wallet | null>;
    /** Busca travando a linha (SELECT ... FOR UPDATE) até o fim da transação. */
    findByIdForUpdate(id: string): Promise<Wallet | null>;
    insert(wallet: Wallet): Promise<void>;
    /** Atualiza saldo/version. Falha se a version no banco não for a esperada. */
    save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
    findById(id: string): Promise<WagerTransaction | null>;
    findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
    findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
    insert(tx: WagerTransaction): Promise<void>;
    update(tx: WagerTransaction): Promise<void>;
    hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
}

export interface LedgerPage {
    entries: WalletLedgerEntry[];
    nextCursor: string | undefined;
}

export interface LedgerRepository {
    insert(entry: WalletLedgerEntry): Promise<void>;
    listByWallet(walletId: string, afterCursor: string | undefined, limit: number): Promise<LedgerPage>;
}

/** Tudo que o caso de uso pode usar DENTRO de uma transação. */
export interface TransactionalContext {
    wallets: WalletRepository;
    transactions: WagerTransactionRepository;
    ledger: LedgerRepository;
}

export interface UnitOfWork {
    /** Roda `work` numa transação SQL. Commit se der certo, rollback se lançar erro. */
    run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}