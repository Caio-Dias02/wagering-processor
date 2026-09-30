import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { CurrencyMismatchError } from "../../src/domain/money/money.errors";
import { Wallet, type WalletMovement } from "../../src/domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";
import {
  InsufficientFundsError,
  NonPositiveAmountError,
  UnbalancedLedgerEntryError,
} from "../../src/domain/wallet/wallet.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const NOW = new Date("2026-09-30T12:00:00.000Z");

let seq = 0;
const nextId = () => `id-${++seq}`;

function openWallet(initial: string) {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initial),
    openingTransactionId: "tx-opening",
    openingEntryId: nextId(),
    at: NOW,
  });
}

function movement(amount: string, money = brl(amount)): WalletMovement {
  return { entryId: nextId(), transactionId: nextId(), money, at: NOW };
}

/** Reconstrói o saldo somando o ledger: a invariante final do desafio. */
function replayLedger(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
    Money.zero("BRL"),
  );
}

describe("Wallet", () => {
  describe("abertura", () => {
    test("com saldo inicial gera lançamento de crédito e version 1", () => {
      const { wallet, openingEntry } = openWallet("100.00");

      expect(wallet.balance.toString()).toBe("100.00");
      expect(wallet.version).toBe(1);
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
      expect(openingEntry?.balanceAfter.toString()).toBe("100.00");
    });

    test("com saldo zero não gera lançamento", () => {
      const { wallet, openingEntry } = openWallet("0.00");

      expect(openingEntry).toBeUndefined();
      expect(wallet.version).toBe(1);
    });
  });

  describe("débito", () => {
    test("reduz o saldo, incrementa version e devolve lançamento balanceado", () => {
      const { wallet } = openWallet("100.00");
      const entry = wallet.debit(movement("25.00"));

      expect(wallet.balance.toString()).toBe("75.00");
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toString()).toBe("100.00");
      expect(entry.balanceAfter.toString()).toBe("75.00");
      expect(entry.isBalanced()).toBe(true);
    });

    test("pode zerar o saldo exatamente", () => {
      const { wallet } = openWallet("100.00");
      wallet.debit(movement("100.00"));
      expect(wallet.balance.isZero()).toBe(true);
    });

    test("cenário 100 / 80 / 80: o segundo débito é rejeitado e nada muda", () => {
      const { wallet } = openWallet("100.00");
      wallet.debit(movement("80.00"));

      expect(() => wallet.debit(movement("80.00"))).toThrow(InsufficientFundsError);
      expect(wallet.balance.toString()).toBe("20.00");
      expect(wallet.version).toBe(2);
    });
  });

  describe("crédito", () => {
    test("aumenta o saldo e incrementa version", () => {
      const { wallet } = openWallet("10.00");
      const entry = wallet.credit(movement("50.00"));

      expect(wallet.balance.toString()).toBe("60.00");
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });
  });

  describe("validações", () => {
    test("rejeita moeda diferente da wallet sem alterar o estado", () => {
      const { wallet } = openWallet("100.00");
      const usd = Money.from({ amount: "10.00", currency: "USD" });

      expect(() => wallet.debit(movement("10.00", usd))).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(movement("10.00", usd))).toThrow(CurrencyMismatchError);
      expect(wallet.balance.toString()).toBe("100.00");
      expect(wallet.version).toBe(1);
    });

    test("rejeita valor zero", () => {
      const { wallet } = openWallet("100.00");
      expect(() => wallet.debit(movement("0.00"))).toThrow(NonPositiveAmountError);
      expect(() => wallet.credit(movement("0.00"))).toThrow(NonPositiveAmountError);
      expect(wallet.version).toBe(1);
    });
  });

  describe("consistência com o ledger", () => {
    test("saldo da wallet é igual ao saldo reconstruído pelo ledger", () => {
      const { wallet, openingEntry } = openWallet("100.00");
      const entries: WalletLedgerEntry[] = [openingEntry!];

      entries.push(wallet.debit(movement("30.00")));
      entries.push(wallet.credit(movement("45.50")));
      entries.push(wallet.debit(movement("0.50")));

      expect(replayLedger(entries).equals(wallet.balance)).toBe(true);
      expect(wallet.balance.toString()).toBe("115.00");
      expect(wallet.version).toBe(4);
    });
  });

  describe("rehydrate", () => {
    test("reconstrói o estado persistido sem alterar version", () => {
      const wallet = Wallet.rehydrate({
        id: "wallet-9",
        playerId: "player-9",
        currency: "BRL",
        balance: brl("42.00"),
        version: 7,
        createdAt: NOW,
        updatedAt: NOW,
      });

      expect(wallet.balance.toString()).toBe("42.00");
      expect(wallet.version).toBe(7);
    });
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    createdAt: NOW,
  };

  test("aceita lançamento com aritmética correta", () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl("10.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("90.00"),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("rejeita lançamento cuja conta não fecha", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("95.00"),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("rejeita lançamento que deixaria saldo negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl("10.00"),
        balanceBefore: brl("5.00"),
        balanceAfter: Money.rehydrate({ amount: "-5.00", currency: "BRL" }),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});