import type { LoggerService } from "@nestjs/common";
import type { LogFields, LoggerPort } from "../../application/ports/observability";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Uma linha JSON por evento, no stdout: {"time","level","msg",...campos}.
 * Serve à aplicação (LoggerPort) e ao próprio Nest (LoggerService), então tudo sai
 * no mesmo formato. Nível mínimo via LOG_LEVEL (debug|info|warn|error|silent).
 */
export class JsonLogger implements LoggerPort, LoggerService {
    private readonly minLevel: number;

    constructor(
        level: string = process.env.LOG_LEVEL ?? "info",
        private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    ) {
        this.minLevel = ORDER[level as Level] ?? ORDER.info;
    }

    // ---- LoggerPort (aplicação)
    info(message: string, fields?: LogFields): void {
        this.emit("info", message, fields);
    }
    warn(message: string, fields?: LogFields): void {
        this.emit("warn", message, fields);
    }
    error(message: string, fields?: LogFields | string): void {
        // O Nest chama error(message, stack, context); a aplicação chama error(message, fields).
        this.emit("error", message, typeof fields === "string" ? { stack: fields } : fields);
    }

    // ---- LoggerService (Nest)
    log(message: unknown, context?: string): void {
        this.emit("info", stringify(message), { context });
    }
    debug(message: unknown, context?: string): void {
        this.emit("debug", stringify(message), { context });
    }
    verbose(message: unknown, context?: string): void {
        this.emit("debug", stringify(message), { context });
    }

    private emit(level: Level, msg: string, fields: LogFields | undefined): void {
        if (ORDER[level] < this.minLevel) return;
        const entry: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
        for (const [key, value] of Object.entries(fields ?? {})) {
            if (value !== undefined) entry[key] = value;
        }
        this.write(JSON.stringify(entry));
    }
}

function stringify(message: unknown): string {
    return typeof message === "string" ? message : JSON.stringify(message);
}
