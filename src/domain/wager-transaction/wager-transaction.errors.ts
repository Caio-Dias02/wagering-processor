import { DomainError } from "../shared/domain-error";

/** Payload que viola as regras de criação (ex.: REFUND sem referência). */
export class InvalidWagerTransactionError extends DomainError {
    readonly code = "INVALID_TRANSACTION";
}

/**
 * Tentativa de transição inválida (ex.: mudar uma transação terminal).
 * É bug de programação, não regra de negócio, por isso NÃO estende DomainError.
 */
export class InvalidTransactionStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidTransactionStateError";
    }
}