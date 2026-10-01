import {
    type BeforeApplicationShutdown,
    Controller,
    Get,
    Global,
    Header,
    Inject,
    Injectable,
    Module,
    type OnApplicationShutdown,
    type OnModuleInit,
} from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Registry } from "prom-client";
import type { LoggerPort, Observability } from "../../application/ports/observability";
import { JsonLogger } from "./json-logger";
import { registerOperationalGauges } from "./operational-gauges";
import { PrometheusMetrics } from "./prometheus-metrics";

export const LOGGER = Symbol("LOGGER");
export const METRICS = Symbol("METRICS");
/** { logger, metrics }: o que os casos de uso recebem. */
export const OBSERVABILITY = Symbol("OBSERVABILITY");

/** Formato texto do Prometheus. Aberto como os health checks (canal de operação). */
@Controller("metrics")
class MetricsController {
    constructor(@Inject(Registry) private readonly registry: Registry) { }

    @Get()
    @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
    metrics(): Promise<string> {
        return this.registry.metrics();
    }
}

@Injectable()
class OperationalGauges implements OnModuleInit {
    constructor(
        @Inject(Registry) private readonly registry: Registry,
        @Inject(MikroORM) private readonly orm: MikroORM,
        @Inject(SQSClient) private readonly sqs: SQSClient,
    ) { }

    onModuleInit(): void {
        registerOperationalGauges(this.registry, this.orm, this.sqs);
    }
}

/** Deixa o desligamento visível no log: começou (com o sinal) e terminou. */
@Injectable()
class ShutdownLog implements BeforeApplicationShutdown, OnApplicationShutdown {
    constructor(@Inject(LOGGER) private readonly logger: LoggerPort) { }

    beforeApplicationShutdown(signal?: string): void {
        this.logger.info("shutting down: stopping workers and finishing in-flight work", { signal });
    }

    onApplicationShutdown(signal?: string): void {
        this.logger.info("shutdown complete", { signal });
    }
}

@Global()
@Module({
    controllers: [MetricsController],
    providers: [
        // Um registry por aplicação (não o global do prom-client): testes que sobem
        // vários apps no mesmo processo não colidem nomes de métrica.
        { provide: Registry, useFactory: () => new Registry() },
        { provide: LOGGER, useFactory: () => new JsonLogger() },
        { provide: METRICS, inject: [Registry], useFactory: (registry: Registry) => new PrometheusMetrics(registry) },
        {
            provide: OBSERVABILITY,
            inject: [LOGGER, METRICS],
            useFactory: (logger: JsonLogger, metrics: PrometheusMetrics): Observability => ({ logger, metrics }),
        },
        OperationalGauges,
        ShutdownLog,
    ],
    exports: [LOGGER, METRICS, OBSERVABILITY],
})
export class ObservabilityModule { }
