import {
    ConnectionException,
    DeadlockException,
    LockWaitTimeoutException,
} from "@mikro-orm/postgresql";

/** Erros de rede do Node (o driver nem sempre embrulha, ex.: ECONNREFUSED vem cru). */
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

/** SQLSTATEs do Postgres que significam "tente de novo daqui a pouco". */
const TRANSIENT_SQLSTATES = new Set([
    "40001", // serialization_failure
    "40P01", // deadlock_detected
    "55P03", // lock_not_available
    "53300", // too_many_connections
    "57P01", // admin_shutdown
    "57P02", // crash_shutdown
    "57P03", // cannot_connect_now
]);

/**
 * O erro é passageiro? (banco caiu, deadlock, pool esgotado...)
 * Nesses casos nada foi decidido de forma definitiva e o cliente pode reenviar.
 */
export function isTransientDatabaseError(error: unknown): boolean {
    if (
        error instanceof ConnectionException ||
        error instanceof DeadlockException ||
        error instanceof LockWaitTimeoutException
    ) {
        return true;
    }
    if (!(error instanceof Error)) return false;

    // Pool sem conexão livre dentro do tempo limite.
    if (error.name === "KnexTimeoutError") return true;

    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
        if (NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code)) return true;
        if (code.startsWith("08")) return true; // classe 08: connection exception
    }
    return false;
}
