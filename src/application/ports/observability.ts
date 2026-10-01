/** Campos de contexto de um log (ids, códigos). Nunca payload financeiro completo. */
export type LogFields = Record<string, string | number | boolean | undefined>;

/** Log estruturado. A aplicação diz O QUE aconteceu; o adaptador decide o formato (JSON). */
export interface LoggerPort {
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export type MetricLabels = Record<string, string>;

/** Métricas. Nomes e labels estáveis, com baixa cardinalidade (nada de ids nos labels). */
export interface MetricsPort {
    increment(name: string, labels?: MetricLabels, value?: number): void;
    observe(name: string, value: number, labels?: MetricLabels): void;
    gauge(name: string, value: number, labels?: MetricLabels): void;
}

export interface Observability {
    logger: LoggerPort;
    metrics: MetricsPort;
}

/** Para testes e para quem não liga observabilidade. */
export const noopLogger: LoggerPort = { info() { }, warn() { }, error() { } };
export const noopMetrics: MetricsPort = { increment() { }, observe() { }, gauge() { } };
export const noopObservability: Observability = { logger: noopLogger, metrics: noopMetrics };

/**
 * Nomes das métricas usadas pela aplicação. Ficam num lugar só para o adaptador
 * (Prometheus) declarar help e labels, e para ninguém digitar um nome errado.
 */
export const Metric = {
    /** labels: source (http|sqs), kind, status, replay (true|false) */
    WagerTransactions: "wager_transactions_total",
    /** labels: source, status */
    WagerProcessingSeconds: "wager_transaction_processing_seconds",
    /** Mensagem repetida barrada pelo inbox. */
    DuplicateMessages: "inbox_duplicate_messages_total",
    /** Corrida perdida (unique/version) que levou a repetir a operação. labels: operation */
    ConcurrencyConflicts: "concurrency_conflicts_total",
    /** labels: outcome (ack|retry|dead_letter), code */
    SqsMessages: "sqs_messages_total",
    /** labels: result (published|failed) */
    OutboxPublish: "outbox_publish_total",
    /** labels: outcome (resolved|rescheduled|expired) */
    PendingReferenceResolutions: "pending_reference_resolutions_total",
    /** labels: result (consistent|divergent) */
    Reconciliations: "wallet_reconciliations_total",
} as const;
