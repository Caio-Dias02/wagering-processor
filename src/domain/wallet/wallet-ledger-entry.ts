import type { Money } from "../money/money";
import { NonPositiveAmountError, UnbalancedLedgerEntryError } from "./wallet.errors";

export enum LedgerDirection {
    Debit = "DEBIT",
    Credit = "CREDIT",
}

export interface LedgerEntryState {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) { }

    /** Cria um lançamento novo, validando a aritmética. */
    static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
        const entry = WalletLedgerEntry.build(props);

        if (!entry.money.isPositive()) {
            throw new NonPositiveAmountError("Ledger entry amount must be positive");
        }
        if (entry.balanceAfter.isNegative()) {
            throw new UnbalancedLedgerEntryError("Ledger entry cannot produce a negative balance");
        }
        if (!entry.isBalanced()) {
            throw new UnbalancedLedgerEntryError("balanceBefore ± money must equal balanceAfter");
        }
        return entry;
    }

    /** Reconstrói a partir do banco, sem revalidar. */
    static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return WalletLedgerEntry.build(state);
    }

    /** balanceBefore ± money === balanceAfter */
    isBalanced(): boolean {
        const expected =
            this.direction === LedgerDirection.Credit
                ? this.balanceBefore.add(this.money)
                : this.balanceBefore.subtract(this.money);
        return expected.equals(this.balanceAfter);
    }

    private static build(s: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(
            s.id, s.walletId, s.transactionId, s.direction,
            s.money, s.balanceBefore, s.balanceAfter, s.createdAt,
        );
    }
}