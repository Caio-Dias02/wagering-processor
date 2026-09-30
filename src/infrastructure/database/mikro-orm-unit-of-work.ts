import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import type { TransactionalContext, UnitOfWork } from "../../application/ports/repositories";
import { MikroOrmLedgerRepository } from "./repositories/mikro-orm-ledger.repository";
import { MikroOrmWagerTransactionRepository } from "./repositories/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletRepository } from "./repositories/mikro-orm-wallet.repository";

export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(private readonly orm: MikroORM) { }

    run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
        // fork: um EntityManager novinho, isolado, para cada transação
        return this.orm.em.fork().transactional((em) => work(createContext(em)));
    }
}

function createContext(em: EntityManager): TransactionalContext {
    return {
        wallets: new MikroOrmWalletRepository(em),
        transactions: new MikroOrmWagerTransactionRepository(em),
        ledger: new MikroOrmLedgerRepository(em),
    };
}