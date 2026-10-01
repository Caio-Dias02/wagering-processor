import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { HttpModule } from "./http/http.module";
import { DatabaseModule } from "./infrastructure/database/database.module";

@Module({
  imports: [DatabaseModule, HttpModule],
  controllers: [HealthController],
})
export class AppModule {}
