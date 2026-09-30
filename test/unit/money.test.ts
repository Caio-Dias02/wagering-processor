import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/money/money.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money", () => {
    describe("criação", () => {
        test("aceita string decimal com 2 casas", () => {
            expect(brl("25.00").toString()).toBe("25.00");
            expect(brl("0.05").toString()).toBe("0.05");
            expect(brl("0.00").isZero()).toBe(true);
        });

        test.each([
            "", "abc", "NaN", "Infinity", "1e3", "10", "10.0", "10.000",
            "-5.00", "+10.00", " 10.00", "10,00", "025.00", "123456789012345678.00",
        ])("rejeita amount inválido '%s'", (amount) => {
            expect(() => brl(amount)).toThrow(InvalidMoneyError);
        });

        test("rejeita number no lugar de string", () => {
            expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" }))
                .toThrow(InvalidMoneyError);
        });

        test.each(["", "brl", "BR", "BRLX"])("rejeita moeda inválida '%s'", (currency) => {
            expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
        });
    });

    describe("aritmética exata", () => {
        test("0.10 + 0.20 = 0.30, sem erro de ponto flutuante", () => {
            expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
        });

        test("subtract pode gerar negativo internamente", () => {
            expect(brl("10.00").subtract(brl("25.50")).toString()).toBe("-15.50");
        });

        test("negate inverte o sinal", () => {
            expect(brl("7.25").negate().toString()).toBe("-7.25");
            expect(brl("7.25").negate().negate().equals(brl("7.25"))).toBe(true);
        });

        test("é imutável: operações não alteram a instância original", () => {
            const dez = brl("10.00");
            dez.add(brl("5.00"));
            dez.subtract(brl("3.00"));
            expect(dez.toString()).toBe("10.00");
        });

        test("valores grandes continuam exatos", () => {
            const big = brl("99999999999999999.99");
            expect(big.add(brl("0.01")).toString()).toBe("100000000000000000.00");
        });
    });

    describe("comparações", () => {
        test("isZero, isPositive, isNegative", () => {
            expect(Money.zero("BRL").isZero()).toBe(true);
            expect(brl("0.01").isPositive()).toBe(true);
            expect(brl("0.01").negate().isNegative()).toBe(true);
        });

        test("isLessThan", () => {
            expect(brl("10.00").isLessThan(brl("10.01"))).toBe(true);
            expect(brl("10.01").isLessThan(brl("10.00"))).toBe(false);
        });

        test("equals considera valor e moeda", () => {
            expect(brl("1.00").equals(brl("1.00"))).toBe(true);
            expect(brl("1.00").equals(usd("1.00"))).toBe(false);
        });
    });

    describe("conflito de moeda", () => {
        test("add, subtract e isLessThan entre moedas diferentes lançam erro", () => {
            expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
            expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
            expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
        });
    });

    describe("serialização", () => {
        test("toJSON devolve MoneyProps com string decimal", () => {
            expect(JSON.stringify(brl("25.00"))).toBe('{"amount":"25.00","currency":"BRL"}');
        });

        test("rehydrate aceita valor negativo persistido", () => {
            expect(Money.rehydrate({ amount: "-15.50", currency: "BRL" }).toString()).toBe("-15.50");
        });
    });
});