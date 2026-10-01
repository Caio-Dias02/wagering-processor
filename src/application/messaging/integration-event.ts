/** Dados comuns a todo evento publicado para fora. */
export interface IntegrationEventProps<T> {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: T;
}

/** Contexto de quem está gerando eventos (de onde veio o pedido, que horas são, como gerar ids). */
export interface EventContext {
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    newId: () => string;
}

/** Envelope serializado: é isso que vai para a coluna `payload` da outbox e para a fila. */
export interface IntegrationEventEnvelope<T> {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
}

/**
 * Evento de integração. Cada evento concreto é uma subclasse que fixa `eventType` e
 * `version` no próprio tipo, em vez de uma string solta em quem publica.
 * `data` carrega só JSON estável (MoneyProps, nunca a instância de Money).
 */
export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;

    readonly eventId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
    readonly data: Readonly<T>;

    protected constructor(props: IntegrationEventProps<T>) {
        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = props.occurredAt;
        this.data = Object.freeze(props.data);
    }

    toJSON(): IntegrationEventEnvelope<T> {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            aggregateId: this.aggregateId,
            correlationId: this.correlationId,
            ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
            occurredAt: this.occurredAt.toISOString(),
            version: this.version,
            data: this.data as T,
        };
    }
}
