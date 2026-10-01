/**
 * Outra transação ganhou a corrida (version mudou ou unique constraint estourou).
 * É seguro repetir a operação inteira numa transação nova.
 */
export class ConcurrencyConflictError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "ConcurrencyConflictError";
    }
}

/** Mesma idempotency key (ou mesmo provider + externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends Error {
    readonly code = "IDEMPOTENCY_CONFLICT";

    constructor(message: string) {
        super(message);
        this.name = "IdempotencyConflictError";
    }
}

/** A wallet não existe: não há onde registrar a transação. */
export class WalletNotFoundError extends Error {
    readonly code = "WALLET_NOT_FOUND";

    constructor(walletId: string) {
        super(`Wallet ${walletId} not found`);
        this.name = "WalletNotFoundError";
    }
}
