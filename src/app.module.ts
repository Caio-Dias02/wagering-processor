import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { HttpModule } from "./http/http.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { MessagingModule } from "./infrastructure/messaging/messaging.module";

@Module({
  imports: [DatabaseModule, MessagingModule, HttpModule],
  controllers: [HealthController],
})
export class AppModule {}
