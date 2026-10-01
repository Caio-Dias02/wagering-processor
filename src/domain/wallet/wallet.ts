import { Money } from "../money/money";
import { CurrencyMismatchError } from "../money/money.errors";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";
import { BalanceLimitExceededError, InsufficientFundsError, NonPositiveAmountError } from "./wallet.errors";

/** Maior saldo representável em NUMERIC(19,2), a coluna onde o saldo é guardado. */
const MAX_BALANCE_AMOUNT = "99999999999999999.99";

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface OpenWalletProps {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId: string;
    openingEntryId: string;
    at: Date;
}

/** Dados de uma movimentação (débito ou crédito). */
export interface WalletMovement {
    entryId: string;
    transactionId: string;
    money: Money;
    at: Date;
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) { }

    static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
        const { initialBalance } = props;
        if (initialBalance.isNegative()) {
            throw new NonPositiveAmountError("Initial balance cannot be negative");
        }

        const currency = initialBalance.currency;
        const wallet = new Wallet(
            props.id, props.playerId, currency, initialBalance, 1, props.at, props.at,
        );

        if (initialBalance.isZero()) {
            return { wallet };
        }

        const openingEntry = WalletLedgerEntry.create({
            id: props.openingEntryId,
            walletId: props.id,
            transactionId: props.openingTransactionId,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(currency),
            balanceAfter: initialBalance,
            createdAt: props.at,
        });

        return { wallet, openingEntry };
    }

    /** Reconstrução a partir da persistência — não revalida transições. */
    static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id, state.playerId, state.currency, state.balance,
            state.version, state.createdAt, state.updatedAt,
        );
    }

    get balance(): Money {
        return this._balance;
    }

    get version(): number {
        return this._version;
    }

    get updatedAt(): Date {
        return this._updatedAt;
    }

    debit(movement: WalletMovement): WalletLedgerEntry {
        this.assertValidMovement(movement.money);
        if (this._balance.isLessThan(movement.money)) {
            throw new InsufficientFundsError();
        }
        return this.apply(LedgerDirection.Debit, movement);
    }

    credit(movement: WalletMovement): WalletLedgerEntry {
        this.assertValidMovement(movement.money);
        if (!this.canCredit(movement.money)) {
            throw new BalanceLimitExceededError();
        }
        return this.apply(LedgerDirection.Credit, movement);
    }

    /** O crédito cabe no limite de saldo? (Não valida moeda: isso é do credit.) */
    canCredit(money: Money): boolean {
        const max = Money.rehydrate({ amount: MAX_BALANCE_AMOUNT, currency: this.currency });
        return !max.isLessThan(this._balance.add(money));
    }

    /** Único lugar que altera o saldo: sempre junto com o lançamento. */
    private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
        const before = this._balance;
        const after =
            direction === LedgerDirection.Credit
                ? before.add(movement.money)
                : before.subtract(movement.money);

        // Cria o lançamento ANTES de mudar o estado: se ele falhar, nada muda.
        const entry = WalletLedgerEntry.create({
            id: movement.entryId,
            walletId: this.id,
            transactionId: movement.transactionId,
            direction,
            money: movement.money,
            balanceBefore: before,
            balanceAfter: after,
            createdAt: movement.at,
        });

        this._balance = after;
        this._version += 1;
        this._updatedAt = movement.at;
        return entry;
    }

    private assertValidMovement(money: Money): void {
        this.assertSameCurrency(money);
        if (!money.isPositive()) {
            throw new NonPositiveAmountError("Movement amount must be positive");
        }
    }

    private assertSameCurrency(money: Money): void {
        if (money.currency !== this.currency) {
            throw new CurrencyMismatchError(this.currency, money.currency);
        }
    }
}