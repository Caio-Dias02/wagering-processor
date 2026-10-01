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

/** Para testes e para quem não liga observabilidade. */
export const noopLogger: LoggerPort = { info() { }, warn() { }, error() { } };
export const noopMetrics: MetricsPort = { increment() { }, observe() { }, gauge() { } };
