import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt: Date;
    publishedAt: Date | undefined;
}

/** Espera antes da 1ª nova tentativa; dobra a cada falha até o teto. */
export const OUTBOX_BASE_DELAY_MS = 1_000;
export const OUTBOX_MAX_DELAY_MS = 5 * 60_000;

/**
 * Evento esperando para ser publicado. É gravado na MESMA transação SQL que a mudança
 * financeira: se o commit acontecer, o evento existe; se não, nenhum dos dois existe.
 * Um worker publica depois. Pode publicar mais de uma vez (at-least-once), por isso o
 * consumidor deduplica pelo eventId.
 */
export class OutboxMessage {
    private constructor(
        readonly id: string,
        readonly aggregateId: string,
        readonly eventType: string,
        readonly payload: Readonly<Record<string, unknown>>,
        readonly occurredAt: Date,
        private _attempts: number,
        private _nextAttemptAt: Date,
        private _publishedAt: Date | undefined,
    ) { }

    /** O id da mensagem é o próprio eventId: o mesmo evento nunca vira duas linhas. */
    static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
        return new OutboxMessage(
            event.eventId,
            event.aggregateId,
            event.eventType,
            event.toJSON() as unknown as Record<string, unknown>,
            event.occurredAt,
            0,
            event.occurredAt,
            undefined,
        );
    }

    static rehydrate(s: OutboxMessageState): OutboxMessage {
        return new OutboxMessage(
            s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt,
        );
    }

    get attempts(): number {
        return this._attempts;
    }
    get nextAttemptAt(): Date {
        return this._nextAttemptAt;
    }
    get publishedAt(): Date | undefined {
        return this._publishedAt;
    }

    isPending(): boolean {
        return this._publishedAt === undefined;
    }

    isDue(now: Date): boolean {
        return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
    }

    markPublished(at: Date): void {
        if (!this.isPending()) return; // publicar de novo é inofensivo: mantém a 1ª data
        this._publishedAt = at;
    }

    /** Falhou ao publicar: conta a tentativa e agenda a próxima com backoff exponencial. */
    scheduleRetry(now: Date): void {
        this._attempts += 1;
        const delay = Math.min(OUTBOX_BASE_DELAY_MS * 2 ** (this._attempts - 1), OUTBOX_MAX_DELAY_MS);
        this._nextAttemptAt = new Date(now.getTime() + delay);
    }
}
