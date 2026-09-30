import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    app.enableShutdownHooks();

    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    console.log(`Servidor rodando em http://localhost:${port}`);
}

bootstrap();