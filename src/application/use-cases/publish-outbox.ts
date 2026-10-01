import type { EventPublisherPort } from "../ports/event-publisher";
import type { UnitOfWork } from "../ports/repositories";

export interface PublishOutboxResult {
    claimed: number;
    published: number;
    failed: number;
}

/** Tamanho do lote: 10 é o máximo do SendMessageBatch do SQS. */
export const OUTBOX_BATCH_SIZE = 10;

/**
 * Publica um lote da outbox. Várias instâncias podem rodar isto ao mesmo tempo:
 * cada uma trava o SEU lote (SKIP LOCKED) e ninguém espera ninguém.
 *
 * As linhas ficam travadas enquanto publicamos. Se o processo morrer no meio, a
 * transação é desfeita, as linhas destravam e outra instância publica de novo.
 * Resultado: pode haver publicação duplicada, nunca perdida (at-least-once).
 * O consumidor deduplica pelo eventId.
 *
 * Não há limite de tentativas: um evento confirmado não pode ser descartado. O
 * backoff tem teto (5 min) e a métrica de outbox lag mostra quando algo está preso.
 */
export class PublishOutbox {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly publisher: EventPublisherPort,
        private readonly now: () => Date = () => new Date(),
        private readonly batchSize = OUTBOX_BATCH_SIZE,
    ) { }

    execute(): Promise<PublishOutboxResult> {
        return this.uow.run(async (ctx) => {
            const due = await ctx.outbox.claimDue(this.now(), this.batchSize);
            if (due.length === 0) return { claimed: 0, published: 0, failed: 0 };

            let confirmed: Set<string>;
            try {
                confirmed = await this.publisher.publish(due);
            } catch {
                confirmed = new Set(); // broker fora: o lote inteiro vai para retry
            }

            const at = this.now();
            for (const message of due) {
                if (confirmed.has(message.id)) message.markPublished(at);
                else message.scheduleRetry(at);
                await ctx.outbox.save(message);
            }
            return { claimed: due.length, published: confirmed.size, failed: due.length - confirmed.size };
        });
    }
}
