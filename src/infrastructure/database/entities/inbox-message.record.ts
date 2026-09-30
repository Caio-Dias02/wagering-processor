import { EntitySchema } from "@mikro-orm/core";

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "text", primary: true },
    messageId: { type: "text", primary: true },
    payloadHash: { type: "text" },
    receivedAt: { type: "Date", columnType: "timestamptz" },
    processedAt: { type: "Date", columnType: "timestamptz", nullable: true },
  },
});