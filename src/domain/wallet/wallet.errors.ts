import { DomainError } from "../shared/domain-error";

export class InsufficientFundsError extends DomainError {
    readonly code = "INSUFFICIENT_FUNDS";

    constructor() {
        super("Insufficient funds");
    }
}

export class NonPositiveAmountError extends DomainError {
    readonly code = "NON_POSITIVE_AMOUNT";
}

export class UnbalancedLedgerEntryError extends DomainError {
    readonly code = "UNBALANCED_LEDGER_ENTRY";
}