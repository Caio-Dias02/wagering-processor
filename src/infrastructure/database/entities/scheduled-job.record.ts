import { EntitySchema } from "@mikro-orm/core";

/** Lease de jobs agendados: garante uma execução por ciclo entre todas as instâncias. */
export class ScheduledJobRecord {
  name!: string;
  lastStartedAt!: Date;
}

export const ScheduledJobSchema = new EntitySchema<ScheduledJobRecord>({
  class: ScheduledJobRecord,
  tableName: "scheduled_jobs",
  properties: {
    name: { type: "text", primary: true },
    lastStartedAt: { type: "Date", columnType: "timestamptz" },
  },
});
