import { createHash } from "node:crypto";

/**
 * JSON canônico: chaves ordenadas em todos os níveis e campos `undefined` removidos.
 * Assim { a: 1, b: 2 } e { b: 2, a: 1 } viram exatamente a mesma string.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

/** SHA-256 (hex) do JSON canônico. */
export function payloadHash(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== "object") return value;

    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
        const child = (value as Record<string, unknown>)[key];
        if (child !== undefined) sorted[key] = sortKeys(child);
    }
    return sorted;
}
