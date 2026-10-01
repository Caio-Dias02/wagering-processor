import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { LoggerPort, MetricsPort } from "../application/ports/observability";
import { isSafeText } from "../application/input-validation";
import { LOGGER, METRICS } from "../infrastructure/observability/observability.module";
import { HttpMetric } from "../infrastructure/observability/prometheus-metrics";

export const CORRELATION_HEADER = "x-correlation-id";

/**
 * Para cada requisição:
 *  - correlation id: reaproveita o X-Correlation-Id do cliente (se for um texto seguro)
 *    ou gera um; devolve no header da resposta e deixa no request para o controller;
 *  - uma linha de log ao terminar (método, rota, status, duração) — sem corpo;
 *  - métricas HTTP por rota (o template "/wallets/:walletId", nunca o id).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
    constructor(
        @Inject(LOGGER) private readonly logger: LoggerPort,
        @Inject(METRICS) private readonly metrics: MetricsPort,
    ) { }

    use(req: Request, res: Response, next: NextFunction): void {
        const incoming = req.headers[CORRELATION_HEADER];
        const correlationId = isSafeText(incoming) && incoming.length <= 128 ? incoming : Bun.randomUUIDv7();
        req.headers[CORRELATION_HEADER] = correlationId;
        res.setHeader("X-Correlation-Id", correlationId);

        const startedAt = performance.now();
        res.on("finish", () => {
            const seconds = (performance.now() - startedAt) / 1000;
            const route = (req.route as { path?: string } | undefined)?.path ?? "unmatched";
            this.metrics.increment(HttpMetric.Requests, { method: req.method, route, status: String(res.statusCode) });
            this.metrics.observe(HttpMetric.DurationSeconds, seconds, { method: req.method, route });
            this.logger.info("http request", {
                correlationId,
                method: req.method,
                route,
                status: res.statusCode,
                durationMs: Math.round(seconds * 1000),
            });
        });
        next();
    }
}
