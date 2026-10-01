import {
    ConnectionException,
    DeadlockException,
    LockWaitTimeoutException,
} from "@mikro-orm/postgresql";

/** Erros de rede do Node (o driver nem sempre embrulha, ex.: ECONNREFUSED vem cru). */
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * SQLSTATEs do Postgres que significam "tente de novo daqui a pouco".
 * Lista explícita de propósito: 08P01 (protocol_violation) também é classe 08, mas é
 * causado pela ENTRADA (ex.: byte NUL num texto) e repetir nunca vai funcionar.
 */
const TRANSIENT_SQLSTATES = new Set([
    "08000", // connection_exception
    "08001", // sqlclient_unable_to_establish_sqlconnection
    "08003", // connection_does_not_exist
    "08004", // sqlserver_rejected_establishment_of_sqlconnection
    "08006", // connection_failure
    "08007", // transaction_resolution_unknown (commit pode ou não ter acontecido; a idempotência cobre)
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
    return typeof code === "string" && (NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code));
}
