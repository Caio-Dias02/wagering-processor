import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";

/** Monta a aplicação. Usada pelo main.ts e pelos testes e2e (mesma configuração). */
export async function createApp(): Promise<INestApplication> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["error", "warn", "log"] });
    app.useBodyParser("json", { limit: "16kb" }); // payloads são pequenos; corpo gigante é abuso
    app.enableShutdownHooks();
    return app;
}
