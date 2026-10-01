import type { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { LedgerPage, UnitOfWork } from "./ports/repositories";

/** Leituras usadas pela API. Nenhuma trava nada nem altera estado. */
export class WageringQueries {
    constructor(private readonly uow: UnitOfWork) { }

    getWallet(walletId: string): Promise<Wallet | null> {
        return this.uow.run((ctx) => ctx.wallets.findById(walletId));
    }

    /** null quando a wallet não existe (para a API responder 404, e não uma página vazia). */
    getLedger(walletId: string, afterCursor: string | undefined, limit: number): Promise<LedgerPage | null> {
        return this.uow.run(async (ctx) => {
            const wallet = await ctx.wallets.findById(walletId);
            return wallet ? ctx.ledger.listByWallet(walletId, afterCursor, limit) : null;
        });
    }

    getTransaction(transactionId: string): Promise<WagerTransaction | null> {
        return this.uow.run((ctx) => ctx.transactions.findById(transactionId));
    }

    getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
        return this.uow.run((ctx) => ctx.transactions.findByProviderAndExternalId(providerId, externalTransactionId));
    }
}
