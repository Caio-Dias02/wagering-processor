import type { OutboxMessage } from "../messaging/outbox-message";

/** Publica eventos para fora (SQS em produção). */
export interface EventPublisherPort {
    /**
     * Tenta publicar todas. Devolve os ids que o broker CONFIRMOU; os demais falharam.
     * Pode lançar se nada pôde ser enviado (ex.: broker fora do ar).
     */
    publish(messages: OutboxMessage[]): Promise<Set<string>>;
}
