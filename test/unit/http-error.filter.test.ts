import { describe, expect, test } from "bun:test";
import type { ArgumentsHost } from "@nestjs/common";
import {
    ConcurrencyConflictError,
    IdempotencyConflictError,
    TransientInfrastructureError,
    WalletAlreadyExistsError,
    WalletNotFoundError,
} from "../../src/application/errors";
import { InvalidInputError } from "../../src/application/input-validation";
import { InvalidMoneyError } from "../../src/domain/money/money.errors";
import { InsufficientFundsError } from "../../src/domain/wallet/wallet.errors";
import { HttpErrorFilter } from "../../src/http/http-error.filter";

/** Roda o filtro com uma resposta falsa e devolve o que ele escreveu. */
function run(error: unknown) {
    const sent: { status?: number; body?: { error: { code: string; message: string } }; headers: Record<string, string> } = { headers: {} };
    const response = {
        setHeader: (name: string, value: string) => { sent.headers[name] = value; },
        status: (code: number) => { sent.status = code; return response; },
        json: (body: typeof sent.body) => { sent.body = body; },
    };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
    const filter = new HttpErrorFilter();
    (filter as unknown as { logger: { error: () => void } }).logger = { error: () => { } };
    filter.catch(error, host);
    return sent;
}

describe("HttpErrorFilter", () => {
    test.each([
        ["payload inválido", new InvalidInputError(["x"]), 400],
        ["dinheiro inválido", new InvalidMoneyError("bad"), 400],
        ["conflito de idempotência", new IdempotencyConflictError("x"), 409],
        ["wallet duplicada", new WalletAlreadyExistsError("p", "BRL"), 409],
        ["wallet inexistente", new WalletNotFoundError("w"), 422],
        ["outra regra de domínio", new InsufficientFundsError(), 422],
        ["banco fora do ar", new TransientInfrastructureError("down"), 503],
        ["corrida que esgotou as tentativas", new ConcurrencyConflictError("race"), 503],
        ["bug", new Error("boom"), 500],
    ])("%s → %i", (_, error, status) => {
        expect(run(error).status).toBe(status);
    });

    test("503 manda Retry-After", () => {
        expect(run(new TransientInfrastructureError("down")).headers["Retry-After"]).toBe("1");
    });

    test("500 não vaza a mensagem interna", () => {
        expect(run(new Error("senha do banco: hunter2")).body?.error.message).toBe("Internal server error");
    });
});
