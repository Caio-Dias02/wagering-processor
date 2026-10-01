import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { HttpModule } from "./http/http.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { MessagingModule } from "./infrastructure/messaging/messaging.module";
import { WorkersModule } from "./infrastructure/workers/workers.module";

@Module({
  imports: [DatabaseModule, MessagingModule, HttpModule, WorkersModule],
  controllers: [HealthController],
})
export class AppModule {}
