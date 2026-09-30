export const FailureCode = {
    // Wallet
    WalletNotFound: "WALLET_NOT_FOUND",
    WalletOwnershipMismatch: "WALLET_OWNERSHIP_MISMATCH",
    CurrencyMismatch: "CURRENCY_MISMATCH",

    // Saldo
    InsufficientFunds: "INSUFFICIENT_FUNDS",
    ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",

    // Referência
    ReferenceNotFound: "REFERENCE_NOT_FOUND",
    ReferenceMismatch: "REFERENCE_MISMATCH",
    ReferenceKindNotAllowed: "REFERENCE_KIND_NOT_ALLOWED",
    ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
    ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
    ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",

    // Infraestrutura
    InfrastructureFailure: "INFRASTRUCTURE_FAILURE",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];