import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import { Metric, type MetricLabels, type MetricsPort } from "../../application/ports/observability";

/** Métricas da camada HTTP (só o adaptador usa). */
export const HttpMetric = {
    Requests: "http_requests_total",
    DurationSeconds: "http_request_duration_seconds",
} as const;

interface Definition {
    type: "counter" | "histogram" | "gauge";
    help: string;
    labelNames: string[];
    buckets?: number[];
}

/** Catálogo: help e labels de cada métrica da aplicação. Labels sem ids (cardinalidade baixa). */
const DEFINITIONS: Record<string, Definition> = {
    [Metric.WagerTransactions]: {
        type: "counter", help: "Wager transactions by outcome", labelNames: ["source", "kind", "status", "replay"],
    },
    [Metric.WagerProcessingSeconds]: {
        type: "histogram", help: "Wager transaction processing latency", labelNames: ["source", "status"],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    },
    [Metric.DuplicateMessages]: { type: "counter", help: "Queue redeliveries stopped by the inbox", labelNames: [] },
    [Metric.ConcurrencyConflicts]: {
        type: "counter", help: "Lost races (unique/version conflicts) that triggered a retry", labelNames: ["operation"],
    },
    [Metric.SqsMessages]: { type: "counter", help: "Consumed SQS messages by outcome", labelNames: ["outcome", "code"] },
    [Metric.OutboxPublish]: { type: "counter", help: "Outbox messages published or failed", labelNames: ["result"] },
    [Metric.PendingReferenceResolutions]: {
        type: "counter", help: "PENDING_REFERENCE resolution attempts", labelNames: ["outcome"],
    },
    [Metric.Reconciliations]: { type: "counter", help: "Wallet reconciliations", labelNames: ["result"] },
    [HttpMetric.Requests]: { type: "counter", help: "HTTP requests", labelNames: ["method", "route", "status"] },
    [HttpMetric.DurationSeconds]: {
        type: "histogram", help: "HTTP request latency", labelNames: ["method", "route"],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    },
};

/** MetricsPort sobre prom-client. Exposto em GET /metrics. */
export class PrometheusMetrics implements MetricsPort {
    private readonly counters = new Map<string, Counter>();
    private readonly histograms = new Map<string, Histogram>();
    private readonly gauges = new Map<string, Gauge>();

    constructor(private readonly registry: Registry) {
        for (const [name, def] of Object.entries(DEFINITIONS)) {
            const base = { name, help: def.help, labelNames: def.labelNames, registers: [registry] };
            if (def.type === "counter") this.counters.set(name, new Counter(base));
            if (def.type === "histogram") this.histograms.set(name, new Histogram({ ...base, buckets: def.buckets }));
            if (def.type === "gauge") this.gauges.set(name, new Gauge(base));
        }
    }

    increment(name: string, labels: MetricLabels = {}, value = 1): void {
        this.get(this.counters, name).inc(labels, value);
    }

    observe(name: string, value: number, labels: MetricLabels = {}): void {
        this.get(this.histograms, name).observe(labels, value);
    }

    gauge(name: string, value: number, labels: MetricLabels = {}): void {
        this.get(this.gauges, name).set(labels, value);
    }

    private get<T>(map: Map<string, T>, name: string): T {
        const metric = map.get(name);
        if (!metric) throw new Error(`Metric ${name} is not declared in the catalog`);
        return metric;
    }
}
