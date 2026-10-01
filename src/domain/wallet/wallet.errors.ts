import { DomainError } from "../shared/domain-error";

export class InsufficientFundsError extends DomainError {
    readonly code = "INSUFFICIENT_FUNDS";

    constructor() {
        super("Insufficient funds");
    }
}

export class BalanceLimitExceededError extends DomainError {
    readonly code = "BALANCE_LIMIT_EXCEEDED";

    constructor() {
        super("Balance limit exceeded");
    }
}

export class NonPositiveAmountError extends DomainError {
    readonly code = "NON_POSITIVE_AMOUNT";
}

export class UnbalancedLedgerEntryError extends DomainError {
    readonly code = "UNBALANCED_LEDGER_ENTRY";
}