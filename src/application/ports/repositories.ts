import type { InboxMessage } from "../messaging/inbox-message";
import type { OutboxMessage } from "../messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import type {
    WagerTransaction,
    WagerTransactionKind,
} from "../../domain/wager-transaction/wager-transaction";

export interface WalletRepository {
    findById(id: string): Promise<Wallet | null>;
    findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
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
    /**
     * Próxima transação PENDING_REFERENCE vencida, TRAVADA até o fim da transação.
     * Linhas já travadas por outro worker são puladas (SKIP LOCKED).
     */
    claimDuePendingReference(now: Date): Promise<PendingReferenceClaim | null>;
    /** Agenda a próxima tentativa de resolver a referência. */
    scheduleReferenceRetry(transactionId: string, attempts: number, nextAttemptAt: Date): Promise<void>;
}

export interface PendingReferenceClaim {
    transaction: WagerTransaction;
    /** Tentativas de resolução já feitas (0 na primeira). */
    attempts: number;
}

export interface LedgerPage {
    entries: WalletLedgerEntry[];
    nextCursor: string | undefined;
}

export interface ReconciliationSnapshot {
    storedBalance: Money;
    calculatedBalance: Money;
    checkedEntries: number;
}

export interface LedgerRepository {
    insert(entry: WalletLedgerEntry): Promise<void>;
    listByWallet(walletId: string, afterCursor: string | undefined, limit: number): Promise<LedgerPage>;
    /**
     * Saldo guardado na wallet e saldo recalculado pelo ledger, lidos no MESMO instante
     * (uma única instrução SQL). null se a wallet não existe.
     */
    reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface OutboxRepository {
    insert(messages: OutboxMessage[]): Promise<void>;
    /**
     * Pega até `limit` mensagens pendentes e vencidas, TRAVANDO as linhas até o fim da
     * transação. Linhas já travadas por outro publisher são puladas (SKIP LOCKED).
     */
    claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
    /** Grava attempts / nextAttemptAt / publishedAt da mensagem. */
    save(message: OutboxMessage): Promise<void>;
}

export interface InboxRepository {
    /**
     * Registra a mensagem. Devolve false se ela já estava registrada (entrega repetida).
     * Se outra transação estiver registrando a mesma mensagem agora, espera ela terminar.
     */
    tryInsert(message: InboxMessage): Promise<boolean>;
}

/** Tudo que o caso de uso pode usar DENTRO de uma transação. */
export interface TransactionalContext {
    wallets: WalletRepository;
    transactions: WagerTransactionRepository;
    ledger: LedgerRepository;
    outbox: OutboxRepository;
    inbox: InboxRepository;
}

export interface UnitOfWork {
    /** Roda `work` numa transação SQL. Commit se der certo, rollback se lançar erro. */
    run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}