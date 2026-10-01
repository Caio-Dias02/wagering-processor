import { createApp } from "./app.factory";
import type { JsonLogger } from "./infrastructure/observability/json-logger";
import { LOGGER } from "./infrastructure/observability/observability.module";

async function bootstrap() {
    const app = await createApp();

    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    app.get<JsonLogger>(LOGGER).info("server listening", { port });
}

bootstrap();
