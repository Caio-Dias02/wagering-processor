import { type EntityManager, type MikroORM, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError, TransientInfrastructureError } from "../../application/errors";
import type { TransactionalContext, UnitOfWork } from "../../application/ports/repositories";
import { MikroOrmInboxRepository } from "./repositories/mikro-orm-inbox.repository";
import { MikroOrmLedgerRepository } from "./repositories/mikro-orm-ledger.repository";
import { MikroOrmOutboxRepository } from "./repositories/mikro-orm-outbox.repository";
import { MikroOrmScheduledJobRepository } from "./repositories/mikro-orm-scheduled-job.repository";
import { MikroOrmWagerTransactionRepository } from "./repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletRepository } from "./repositories/mikro-orm-wallet.repository";
import { isTransientDatabaseError } from "./transient-errors";

export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(private readonly orm: MikroORM) { }

    async run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
        try {
            // fork: um EntityManager novinho, isolado, para cada transação
            return await this.orm.em.fork().transactional((em) => work(createContext(em)));
        } catch (error) {
            // Unique estourou = outra transação gravou primeiro. A aplicação não conhece
            // o MikroORM, então traduzimos para um erro dela, que diz "pode repetir".
            if (error instanceof UniqueConstraintViolationException) {
                const constraint = (error as { constraint?: string }).constraint ?? "unknown";
                throw new ConcurrencyConflictError(`Unique constraint violated: ${constraint}`, { cause: error });
            }
            if (isTransientDatabaseError(error)) {
                throw new TransientInfrastructureError("Database temporarily unavailable", { cause: error });
            }
            throw error;
        }
    }
}

function createContext(em: EntityManager): TransactionalContext {
    return {
        wallets: new MikroOrmWalletRepository(em),
        transactions: new MikroOrmWagerTransactionRepository(em),
        ledger: new MikroOrmLedgerRepository(em),
        outbox: new MikroOrmOutboxRepository(em),
        inbox: new MikroOrmInboxRepository(em),
        jobs: new MikroOrmScheduledJobRepository(em),
    };
}
