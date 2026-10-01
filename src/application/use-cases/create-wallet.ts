import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wager-transaction/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletAlreadyExistsError } from "../errors";
import type { UnitOfWork } from "../ports/repositories";
import { retryOnConflict } from "../retry";

export interface CreateWalletCommand {
    playerId: string;
    initialBalance: MoneyProps;
}

export class CreateWallet {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly newId: () => string = () => Bun.randomUUIDv7(),
        private readonly now: () => Date = () => new Date(),
    ) { }

    async execute(command: CreateWalletCommand): Promise<Wallet> {
        const initialBalance = Money.from(command.initialBalance);

        // Se duas criações correrem juntas, a segunda estoura a unique (player, currency),
        // repete, e na nova tentativa encontra a wallet da primeira: vira conflito.
        return retryOnConflict(() =>
            this.uow.run(async (ctx) => {
                const existing = await ctx.wallets.findByPlayerAndCurrency(command.playerId, initialBalance.currency);
                if (existing) throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);

                const at = this.now();
                const walletId = this.newId();
                const openingTransactionId = this.newId();
                const { wallet, openingEntry } = Wallet.open({
                    id: walletId,
                    playerId: command.playerId,
                    initialBalance,
                    openingTransactionId,
                    openingEntryId: this.newId(),
                    at,
                });
                await ctx.wallets.insert(wallet);

                // Saldo inicial zero: nada a lançar, então nem OPENING existe.
                if (openingEntry) {
                    await ctx.transactions.insert(
                        WagerTransaction.createOpening({
                            id: openingTransactionId,
                            walletId,
                            playerId: command.playerId,
                            money: initialBalance,
                            createdAt: at,
                        }),
                    );
                    await ctx.ledger.insert(openingEntry);
                }

                return wallet;
            }),
        );
    }
}
