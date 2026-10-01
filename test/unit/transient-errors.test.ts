import { describe, expect, test } from "bun:test";
import { isTransientDatabaseError } from "../../src/infrastructure/database/transient-errors";

function withCode(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

describe("isTransientDatabaseError", () => {
    test.each([
        ["banco recusando conexão", withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")],
        ["deadlock", withCode("deadlock detected", "40P01")],
        ["servidor desligando", withCode("terminating connection due to administrator command", "57P01")],
        // Postgres caiu com as conexões do pool abertas: o pg lança Error sem código.
        ["conexão caiu no meio da query", new Error("Connection terminated unexpectedly")],
        ["conexão já quebrada", new Error("Client has encountered a connection error and is not queryable")],
        ["transação morreu junto com a conexão", new Error("Transaction query already complete, run with DEBUG=knex:tx for more info")],
    ])("%s → transitório (503, pode reenviar)", (_, error) => {
        expect(isTransientDatabaseError(error)).toBe(true);
    });

    test.each([
        ["violação de check", withCode("new row violates check constraint", "23514")],
        ["byte NUL no texto (08P01, repetir não adianta)", withCode("invalid message format", "08P01")],
        ["erro qualquer sem código", new Error("Cannot read properties of undefined")],
        ["não é Error", "boom"],
    ])("%s → não transitório", (_, error) => {
        expect(isTransientDatabaseError(error)).toBe(false);
    });
});
