import { CurrencyMismatchError, InvalidMoneyError } from "./money.errors";

export interface MoneyProps {
    amount: string;
    currency: string;
}

// Entrada de contrato (API/fila): nunca negativo, sempre 2 casas.
// Até 17 dígitos inteiros + 2 decimais, para caber em NUMERIC(19,2).
const CONTRACT_AMOUNT = /^(0|[1-9]\d{0,16})\.\d{2}$/;

// Valor já persistido: pode ser negativo (ex.: resultado de negate()).
const STORED_AMOUNT = /^-?(0|[1-9]\d{0,16})\.\d{2}$/;

const CURRENCY = /^[A-Z]{3}$/;

export class Money {
    private constructor(
        private readonly cents: bigint,
        public readonly currency: string,
    ) { }

    /** Porta de entrada para valores vindos de fora (API, fila). */
    static from(props: MoneyProps): Money {
        return Money.parse(props, CONTRACT_AMOUNT);
    }

    /** Reconstrução a partir do banco. */
    static rehydrate(props: MoneyProps): Money {
        return Money.parse(props, STORED_AMOUNT);
    }

    static zero(currency: string): Money {
        Money.assertValidCurrency(currency);
        return new Money(0n, currency);
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.cents + other.cents, this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.cents - other.cents, this.currency);
    }

    negate(): Money {
        return new Money(-this.cents, this.currency);
    }

    isZero(): boolean {
        return this.cents === 0n;
    }

    isPositive(): boolean {
        return this.cents > 0n;
    }

    isNegative(): boolean {
        return this.cents < 0n;
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.cents < other.cents;
    }

    equals(other: Money): boolean {
        return this.currency === other.currency && this.cents === other.cents;
    }

    toJSON(): MoneyProps {
        return { amount: this.toString(), currency: this.currency };
    }

    toString(): string {
        const negative = this.cents < 0n;
        const abs = negative ? -this.cents : this.cents;
        const integer = abs / 100n;
        const fraction = (abs % 100n).toString().padStart(2, "0");
        return `${negative ? "-" : ""}${integer}.${fraction}`;
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new CurrencyMismatchError(this.currency, other.currency);
        }
    }

    private static parse(props: MoneyProps, pattern: RegExp): Money {
        const { amount, currency } = props;

        if (typeof amount !== "string" || !pattern.test(amount)) {
            throw new InvalidMoneyError(`Invalid amount: ${String(amount)}`);
        }
        Money.assertValidCurrency(currency);

        // "25.00" -> "2500" -> 2500n centavos
        return new Money(BigInt(amount.replace(".", "")), currency);
    }

    private static assertValidCurrency(currency: unknown): asserts currency is string {
        if (typeof currency !== "string" || !CURRENCY.test(currency)) {
            throw new InvalidMoneyError(`Invalid currency: ${String(currency)}`);
        }
    }
}