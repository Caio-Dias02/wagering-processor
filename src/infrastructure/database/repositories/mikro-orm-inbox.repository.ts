import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxMessage } from "../../../application/messaging/inbox-message";
import type { InboxRepository } from "../../../application/ports/repositories";
import { InboxMessageRecord } from "../entities/inbox-message.record";

export class MikroOrmInboxRepository implements InboxRepository {
    constructor(private readonly em: EntityManager) { }

    async tryInsert(message: InboxMessage): Promise<boolean> {
        // ON CONFLICT DO NOTHING: se a PK (consumer_name, message_id) já existe, nada é
        // inserido e affectedRows = 0. Se outra transação está inserindo a mesma PK agora,
        // o Postgres espera ela terminar antes de decidir.
        const result = await this.em
            .createQueryBuilder(InboxMessageRecord)
            .insert({
                consumerName: message.consumerName,
                messageId: message.messageId,
                payloadHash: message.payloadHash,
                receivedAt: message.receivedAt,
                processedAt: message.processedAt ?? null,
            })
            .onConflict(["consumerName", "messageId"])
            .ignore()
            .execute("run");
        return result.affectedRows === 1;
    }
}
