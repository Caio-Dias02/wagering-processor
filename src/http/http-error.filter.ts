import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response } from "express";
import {
    ConcurrencyConflictError,
    IdempotencyConflictError,
    TransientInfrastructureError,
    WalletAlreadyExistsError,
    WalletNotFoundError,
} from "../application/errors";
import { InvalidInputError } from "../application/input-validation";
import { InvalidMoneyError } from "../domain/money/money.errors";
import { DomainError } from "../domain/shared/domain-error";
import { InvalidWagerTransactionError } from "../domain/wager-transaction/wager-transaction.errors";

interface ErrorBody {
    error: { code: string; message: string; issues?: string[] };
}

/**
 * Traduz erros em status HTTP. O provedor decide o que fazer só pelo status:
 *
 *  400 payload inválido          → corrigir o payload; reenviar igual não adianta
 *  404 recurso não existe (GETs)
 *  409 conflito                  → key já usada com outro payload / wallet duplicada
 *  422 rejeição de negócio       → decisão final; não reenviar
 *  503 falha transitória         → reenviar depois (com a MESMA key: é seguro)
 *  500 bug                       → nosso problema
 *
 * Rejeições que viram transação REJECTED (ex.: saldo insuficiente) não passam por
 * aqui: o controller responde 422 com o resultado gravado.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpErrorFilter.name);

    catch(error: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>();
        const [status, body] = this.translate(error);

        if (status === HttpStatus.SERVICE_UNAVAILABLE) response.setHeader("Retry-After", "1");
        if (status >= 500) this.logger.error(body.error.message, error instanceof Error ? error.stack : undefined);

        response.status(status).json(body);
    }

    private translate(error: unknown): [number, ErrorBody] {
        if (error instanceof InvalidInputError) {
            return [400, { error: { code: error.code, message: "Invalid request", issues: error.issues } }];
        }
        if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
            return [400, body(error.code, error.message)];
        }
        if (error instanceof IdempotencyConflictError || error instanceof WalletAlreadyExistsError) {
            return [409, body(error.code, error.message)];
        }
        if (error instanceof WalletNotFoundError) {
            return [422, body(error.code, error.message)];
        }
        if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError) {
            return [503, body("TEMPORARILY_UNAVAILABLE", "Temporary failure, retry with the same Idempotency-Key")];
        }
        if (error instanceof DomainError) {
            return [422, body(error.code, error.message)];
        }
        if (error instanceof HttpException) {
            // Erros do próprio Nest (rota inexistente, JSON malformado...): mesmo formato de corpo.
            const status = error.getStatus();
            return [status, body(HttpStatus[status] ?? "HTTP_ERROR", error.message)];
        }
        const clientError = asExposedClientError(error);
        if (clientError) {
            // Erros do body-parser (corpo grande demais, charset inválido...) seguem o padrão http-errors.
            return [clientError.status, body(HttpStatus[clientError.status] ?? "HTTP_ERROR", clientError.message)];
        }
        // Nunca vaza detalhe interno para o cliente; o log fica com o stack.
        return [500, body("INTERNAL_ERROR", "Internal server error")];
    }
}

/** Erro 4xx no padrão http-errors marcado como seguro para mostrar ao cliente. */
function asExposedClientError(error: unknown): { status: number; message: string } | undefined {
    if (!(error instanceof Error)) return undefined;
    const { status, expose } = error as { status?: unknown; expose?: unknown };
    if (expose === true && typeof status === "number" && status >= 400 && status < 500) {
        return { status, message: error.message };
    }
    return undefined;
}

function body(code: string, message: string): ErrorBody {
    return { error: { code, message } };
}
