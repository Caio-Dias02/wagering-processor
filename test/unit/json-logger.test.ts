import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../../src/infrastructure/observability/json-logger";

function capture(level = "info") {
    const lines: Record<string, unknown>[] = [];
    const logger = new JsonLogger(level, (line) => lines.push(JSON.parse(line)));
    return { logger, lines };
}

describe("JsonLogger", () => {
    test("uma linha JSON com time, level, msg e os campos (sem os undefined)", () => {
        const { logger, lines } = capture();
        logger.info("wager transaction decided", { transactionId: "tx-1", failureCode: undefined, replay: false });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toEqual({
            time: expect.any(String), level: "info", msg: "wager transaction decided", transactionId: "tx-1", replay: false,
        });
    });

    test("respeita o nível mínimo", () => {
        const { logger, lines } = capture("warn");
        logger.info("não sai");
        logger.warn("sai");
        logger.error("sai também");
        expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
    });

    test("silent não escreve nada", () => {
        const { logger, lines } = capture("silent");
        logger.error("nada");
        expect(lines).toHaveLength(0);
    });

    test("aceita a assinatura do Nest: error(message, stack) e log(message, context)", () => {
        const { logger, lines } = capture();
        logger.error("boom", "Error: boom\n    at x");
        logger.log("Nest application successfully started", "NestApplication");
        expect(lines[0]).toMatchObject({ level: "error", msg: "boom", stack: "Error: boom\n    at x" });
        expect(lines[1]).toMatchObject({ level: "info", context: "NestApplication" });
    });
});
