import { Migration } from '@mikro-orm/migrations';

export class Migration20261001113612 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "scheduled_jobs" ("name" text not null, "last_started_at" timestamptz not null, constraint "scheduled_jobs_pkey" primary key ("name"));`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "scheduled_jobs" cascade;`);
  }

}
