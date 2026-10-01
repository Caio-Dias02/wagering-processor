import { describe, expect, test } from "bun:test";
import { canonicalJson, payloadHash } from "../../src/application/payload-hash";

describe("payloadHash", () => {
    test("ordem das chaves não muda o hash", () => {
        const a = { kind: "BET", money: { amount: "10.00", currency: "BRL" }, roundId: "r1" };
        const b = { roundId: "r1", money: { currency: "BRL", amount: "10.00" }, kind: "BET" };
        expect(payloadHash(a)).toBe(payloadHash(b));
    });

    test("campo undefined é o mesmo que campo ausente", () => {
        expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    });

    test("qualquer valor diferente muda o hash", () => {
        const base = { kind: "BET", money: { amount: "10.00", currency: "BRL" } };
        const changed = { kind: "BET", money: { amount: "10.01", currency: "BRL" } };
        expect(payloadHash(base)).not.toBe(payloadHash(changed));
    });

    test("é SHA-256 em hex", () => {
        expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    });
});
