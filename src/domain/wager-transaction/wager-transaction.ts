import type { Money } from "../money/money";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import {
    InvalidTransactionStateError,
    InvalidWagerTransactionError,
} from "./wager-transaction.errors";

export enum WagerTransactionKind {
    Opening = "OPENING",
    Bet = "BET",
    Win = "WIN",
    Loss = "LOSS",
    Refund = "REFUND",
    Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
    Pending = "PENDING",
    PendingReference = "PENDING_REFERENCE",
    Processed = "PROCESSED",
    Rejected = "REJECTED",
    Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    /** id no provedor, não o id interno */
    referenceExternalTransactionId?: string;
    createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    /** Saldo observado quando a transação foi decidida (para replay idempotente). */
    observedBalance?: Money;
    processedAt?: Date;
}

/** Provider reservado para transações internas (OPENING). O banco também garante isso. */
export const INTERNAL_PROVIDER_ID = "internal";

/** Quais kinds cada operação pode referenciar. */
const ALLOWED_REFERENCES: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
    [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
    [WagerTransactionKind.Rollback]: [
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
    ],
};

const TERMINAL = new Set([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
    readonly id: string;
    readonly providerId: string;
    readonly externalTransactionId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly walletId: string;
    readonly playerId: string;
    readonly roundId: string;
    readonly gameId: string;
    readonly kind: WagerTransactionKind;
    readonly money: Money;
    readonly referenceExternalTransactionId: string | undefined;
    readonly createdAt: Date;

    private _status: WagerTransactionStatus;
    private _referenceTransactionId: string | undefined;
    private _failureCode: FailureCode | undefined;
    private _observedBalance: Money | undefined;
    private _processedAt: Date | undefined;

    private constructor(s: WagerTransactionState) {
        this.id = s.id;
        this.providerId = s.providerId;
        this.externalTransactionId = s.externalTransactionId;
        this.idempotencyKey = s.idempotencyKey;
        this.payloadHash = s.payloadHash;
        this.walletId = s.walletId;
        this.playerId = s.playerId;
        this.roundId = s.roundId;
        this.gameId = s.gameId;
        this.kind = s.kind;
        this.money = s.money;
        this.referenceExternalTransactionId = s.referenceExternalTransactionId;
        this.createdAt = s.createdAt;
        this._status = s.status;
        this._referenceTransactionId = s.referenceTransactionId;
        this._failureCode = s.failureCode;
        this._observedBalance = s.observedBalance;
        this._processedAt = s.processedAt;
    }

    // ---------- factories ----------

    /** Transação vinda de um provedor. Nasce em PENDING. */
    static create(props: CreateWagerTransactionProps): WagerTransaction {
        if (props.kind === WagerTransactionKind.Opening) {
            throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
        }
        if (props.providerId === INTERNAL_PROVIDER_ID) {
            throw new InvalidWagerTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
        }
        WagerTransaction.validate(props);
        return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
    }

    /** Transação interna de abertura da wallet. Já nasce PROCESSED. */
    static createOpening(props: {
        id: string;
        walletId: string;
        playerId: string;
        money: Money;
        createdAt: Date;
    }): WagerTransaction {
        return new WagerTransaction({
            id: props.id,
            providerId: INTERNAL_PROVIDER_ID,
            externalTransactionId: `opening:${props.walletId}`,
            idempotencyKey: `internal:opening:${props.walletId}`,
            payloadHash: "",
            walletId: props.walletId,
            playerId: props.playerId,
            roundId: "opening",
            gameId: "internal",
            kind: WagerTransactionKind.Opening,
            money: props.money,
            createdAt: props.createdAt,
            status: WagerTransactionStatus.Processed,
            observedBalance: props.money,
            processedAt: props.createdAt,
        });
    }

    /** Reconstrução a partir do banco — não revalida. */
    static rehydrate(state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(state);
    }

    // ---------- getters ----------

    get status(): WagerTransactionStatus {
        return this._status;
    }
    get referenceTransactionId(): string | undefined {
        return this._referenceTransactionId;
    }
    get failureCode(): FailureCode | undefined {
        return this._failureCode;
    }
    get observedBalance(): Money | undefined {
        return this._observedBalance;
    }
    get processedAt(): Date | undefined {
        return this._processedAt;
    }

    // ---------- transições ----------

    markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
        this.assertNotTerminal("markProcessed");
        this._status = WagerTransactionStatus.Processed;
        this._referenceTransactionId = referenceTransactionId;
        this._observedBalance = observedBalance;
        this._processedAt = at;
    }

    markPendingReference(): void {
        if (this._status !== WagerTransactionStatus.Pending) {
            throw new InvalidTransactionStateError(
                `Cannot mark ${this._status} transaction as PENDING_REFERENCE`,
            );
        }
        this._status = WagerTransactionStatus.PendingReference;
    }

    reject(code: FailureCode, observedBalance: Money | undefined, at: Date): void {
        this.assertNotTerminal("reject");
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
        this._observedBalance = observedBalance;
        this._processedAt = at;
    }

    fail(code: FailureCode, at: Date): void {
        this.assertNotTerminal("fail");
        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
        this._processedAt = at;
    }

    // ---------- consultas de domínio ----------

    isTerminal(): boolean {
        return TERMINAL.has(this._status);
    }

    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    requiresReference(): boolean {
        return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
    }

    isReversal(): boolean {
        return this.requiresReference();
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    /** Direção do lançamento no ledger. ROLLBACK é o inverso da referência. */
    ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
        switch (this.kind) {
            case WagerTransactionKind.Bet:
                return LedgerDirection.Debit;
            case WagerTransactionKind.Opening:
            case WagerTransactionKind.Win:
            case WagerTransactionKind.Refund:
                return LedgerDirection.Credit;
            case WagerTransactionKind.Rollback: {
                if (!reference) {
                    throw new InvalidTransactionStateError("ROLLBACK needs its reference to decide direction");
                }
                return reference.ledgerDirectionFor() === LedgerDirection.Debit
                    ? LedgerDirection.Credit
                    : LedgerDirection.Debit;
            }
            case WagerTransactionKind.Loss:
                throw new InvalidTransactionStateError("LOSS does not produce ledger entries");
        }
    }

    /**
     * Confere se a referência é válida para esta transação.
     * Assume que a referência já está em estado terminal.
     * Retorna o FailureCode do problema, ou undefined se estiver tudo certo.
     * ("Já foi revertida?" depende do banco e é conferido no caso de uso.)
     */
    checkReference(reference: WagerTransaction): FailureCode | undefined {
        const sameContext =
            reference.providerId === this.providerId &&
            reference.playerId === this.playerId &&
            reference.walletId === this.walletId &&
            reference.roundId === this.roundId &&
            reference.money.currency === this.money.currency;
        if (!sameContext) return FailureCode.ReferenceMismatch;

        const allowed = ALLOWED_REFERENCES[this.kind] ?? [];
        if (!allowed.includes(reference.kind)) return FailureCode.ReferenceKindNotAllowed;

        if (reference.status !== WagerTransactionStatus.Processed) {
            return FailureCode.ReferenceNotProcessed;
        }

        if (this.isReversal() && !this.money.equals(reference.money)) {
            return FailureCode.ReferenceAmountMismatch;
        }

        return undefined;
    }

    // ---------- privados ----------

    private assertNotTerminal(action: string): void {
        if (this.isTerminal()) {
            throw new InvalidTransactionStateError(`Cannot ${action}: transaction is ${this._status}`);
        }
    }

    private static validate(p: CreateWagerTransactionProps): void {
        const required = {
            providerId: p.providerId,
            externalTransactionId: p.externalTransactionId,
            idempotencyKey: p.idempotencyKey,
            walletId: p.walletId,
            playerId: p.playerId,
            roundId: p.roundId,
            gameId: p.gameId,
        };
        for (const [field, value] of Object.entries(required)) {
            if (!value || value.trim() === "") {
                throw new InvalidWagerTransactionError(`${field} is required`);
            }
        }

        const needsReference =
            p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
        if (needsReference && !p.referenceExternalTransactionId) {
            throw new InvalidWagerTransactionError(`${p.kind} requires referenceExternalTransactionId`);
        }
        if (p.referenceExternalTransactionId === p.externalTransactionId) {
            // Nunca resolveria: ficaria em PENDING_REFERENCE para sempre.
            throw new InvalidWagerTransactionError("A transaction cannot reference itself");
        }
        if (p.kind === WagerTransactionKind.Bet && p.referenceExternalTransactionId) {
            throw new InvalidWagerTransactionError("BET cannot reference another transaction");
        }

        // LOSS pode vir com 0.00; o resto precisa ser positivo.
        if (p.kind !== WagerTransactionKind.Loss && !p.money.isPositive()) {
            throw new InvalidWagerTransactionError(`${p.kind} amount must be positive`);
        }
    }
}