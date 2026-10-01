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

/** Já existe wallet para esse playerId + currency. */
export class WalletAlreadyExistsError extends Error {
    readonly code = "WALLET_ALREADY_EXISTS";

    constructor(playerId: string, currency: string) {
        super(`Player ${playerId} already has a ${currency} wallet`);
        this.name = "WalletAlreadyExistsError";
    }
}

/**
 * Banco fora do ar, deadlock, lock que demorou demais...
 * Nada foi decidido de forma definitiva: o cliente pode reenviar (a idempotência protege).
 */
export class TransientInfrastructureError extends Error {
    readonly code = "TRANSIENT_INFRASTRUCTURE_FAILURE";

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "TransientInfrastructureError";
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
