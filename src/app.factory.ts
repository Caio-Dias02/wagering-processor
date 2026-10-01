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
    app.enableShutdownHooks();
    return app;
}
