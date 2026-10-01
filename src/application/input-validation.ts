import type { MoneyProps } from "../domain/money/money";
import type { CreateWalletCommand } from "./use-cases/create-wallet";
import type { ProcessWagerTransactionCommand } from "./use-cases/process-wager-transaction";

/**
 * Converte entrada não confiável (JSON da API ou da fila) nos comandos dos casos de uso.
 * Confere só FORMATO: as regras de negócio continuam no domínio.
 * HTTP e SQS usam as mesmas funções, para os dois canais recusarem as mesmas coisas.
 */

/** O formato do pedido está errado. Lista todos os problemas de uma vez. */
export class InvalidInputError extends Error {
    readonly code = "INVALID_REQUEST";

    constructor(readonly issues: string[]) {
        super(`Invalid request: ${issues.join("; ")}`);
        this.name = "InvalidInputError";
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 255;
// Caracteres de controle (inclui o NUL, que o Postgres não aceita em text).
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID.test(value);
}

/** Texto aceitável como identificador: não vazio, tamanho limitado, sem caracteres de controle. */
export function isSafeText(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT && !CONTROL_CHARS.test(value);
}

export function parseCreateWalletInput(body: unknown): CreateWalletCommand {
    const r = new Reader(body);
    const command = {
        playerId: r.uuid("playerId"),
        initialBalance: r.money("initialBalance"),
    };
    r.done();
    return command;
}

export function parseWagerTransactionInput(body: unknown, idempotencyKey: unknown): ProcessWagerTransactionCommand {
    const r = new Reader(body);
    const command = {
        idempotencyKey: r.text("Idempotency-Key", idempotencyKey),
        providerId: r.text("providerId"),
        externalTransactionId: r.text("externalTransactionId"),
        playerId: r.uuid("playerId"),
        walletId: r.uuid("walletId"),
        roundId: r.text("roundId"),
        gameId: r.text("gameId"),
        kind: r.text("kind"),
        money: r.money("money"),
        referenceExternalTransactionId: r.optionalText("referenceExternalTransactionId"),
    };
    r.done();
    return command;
}

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

export interface WagerTransactionMessage {
    messageId: string;
    command: ProcessWagerTransactionCommand;
}

/**
 * Mensagem da fila (§10): { messageId, type, occurredAt, data: {...} }.
 * `data` passa pela MESMA validação do HTTP; a key vem em data.idempotencyKey.
 */
export function parseWagerTransactionMessage(body: unknown): WagerTransactionMessage {
    const envelope = new Reader(body);
    const messageId = envelope.text("messageId");
    const type = envelope.text("type");
    envelope.done();
    if (type !== WAGER_TRANSACTION_REQUESTED) {
        throw new InvalidInputError([`type must be ${WAGER_TRANSACTION_REQUESTED}`]);
    }

    const data = (body as Record<string, unknown>).data;
    const idempotencyKey = typeof data === "object" && data !== null
        ? (data as Record<string, unknown>).idempotencyKey
        : undefined;
    const command = parseWagerTransactionInput(data, idempotencyKey);
    // A mensagem é a causa do pedido; sem correlation id próprio, ela também o identifica.
    return { messageId, command: { ...command, correlationId: messageId, causationId: messageId } };
}

/** Lê campos acumulando erros, em vez de parar no primeiro. */
class Reader {
    private readonly issues: string[] = [];
    private readonly obj: Record<string, unknown>;

    constructor(body: unknown) {
        const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
        if (!isObject) this.issues.push("body must be a JSON object");
        this.obj = isObject ? (body as Record<string, unknown>) : {};
    }

    text(field: string, value: unknown = this.obj[field]): string {
        if (typeof value !== "string" || value.trim() === "") {
            this.issues.push(`${field} is required and must be a non-empty string`);
            return "";
        }
        if (value.length > MAX_TEXT) {
            this.issues.push(`${field} must have at most ${MAX_TEXT} characters`);
        }
        if (CONTROL_CHARS.test(value)) {
            this.issues.push(`${field} must not contain control characters`);
        }
        return value;
    }

    optionalText(field: string): string | undefined {
        return this.obj[field] === undefined || this.obj[field] === null ? undefined : this.text(field);
    }

    uuid(field: string): string {
        const value = this.obj[field];
        if (!isUuid(value)) {
            this.issues.push(`${field} must be a UUID`);
            return "";
        }
        return value;
    }

    /** Só confere que são strings; quem valida o valor em si é o Money.from. */
    money(field: string): MoneyProps {
        const value = this.obj[field] as Record<string, unknown> | undefined;
        const ok =
            typeof value === "object" && value !== null &&
            typeof value.amount === "string" && typeof value.currency === "string";
        if (!ok) {
            this.issues.push(`${field} must be { "amount": string, "currency": string }`);
            return { amount: "", currency: "" };
        }
        return { amount: value.amount as string, currency: value.currency as string };
    }

    done(): void {
        if (this.issues.length > 0) throw new InvalidInputError(this.issues);
    }
}
