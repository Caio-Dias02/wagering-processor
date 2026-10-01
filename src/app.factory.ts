import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { JsonLogger } from "./infrastructure/observability/json-logger";
import { LOGGER } from "./infrastructure/observability/observability.module";

/** Monta a aplicação. Usada pelo main.ts e pelos testes e2e (mesma configuração). */
export async function createApp(): Promise<INestApplication> {
    // bufferLogs: os logs do boot esperam o logger JSON ficar pronto, para sair tudo no mesmo formato.
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
    app.useLogger(app.get<JsonLogger>(LOGGER));
    app.useBodyParser("json", { limit: "16kb" }); // payloads são pequenos; corpo gigante é abuso
    // SIGTERM/SIGINT: para os workers, termina o que está em andamento, fecha banco e SQS,
    // e sai com código 0 (sem useProcessExit o Nest reenvia o sinal e o processo sai com 143).
    app.enableShutdownHooks(undefined, { useProcessExit: true });
    return app;
}
