import { ConcurrencyConflictError } from "./errors";

/** Quantas vezes repetimos quando outra transação ganha a corrida. */
export const MAX_CONFLICT_ATTEMPTS = 3;

/**
 * Roda `attempt` de novo quando ele perde uma corrida (ConcurrencyConflictError).
 * Cada tentativa precisa abrir a SUA transação: depois de um erro o Postgres
 * aborta a transação inteira, então não dá para "continuar" a anterior.
 */
export async function retryOnConflict<T>(attempt: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n++) {
        try {
            return await attempt();
        } catch (error) {
            if (error instanceof ConcurrencyConflictError && n < MAX_CONFLICT_ATTEMPTS) continue;
            throw error;
        }
    }
}
