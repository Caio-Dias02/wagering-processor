import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { InvalidInputError, isUuid, parseCreateWalletInput } from "../application/input-validation";
import { WageringQueries } from "../application/queries";
import { CreateWallet } from "../application/use-cases/create-wallet";
import { ReconcileWallet } from "../application/use-cases/reconcile-wallet";
import { AuthGuard } from "./auth.guard";
import { ledgerCursor, presentLedgerEntry, presentWallet } from "./presenters";
import { CORRELATION_HEADER } from "./request-context.middleware";

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
    constructor(
        @Inject(CreateWallet) private readonly createWallet: CreateWallet,
        @Inject(WageringQueries) private readonly queries: WageringQueries,
        @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    ) { }

    @Post()
    @HttpCode(201)
    async create(@Body() body: unknown, @Headers(CORRELATION_HEADER) correlationId: string) {
        const wallet = await this.createWallet.execute({ ...parseCreateWalletInput(body), correlationId });
        return presentWallet(wallet);
    }

    @Get(":walletId")
    async get(@Param("walletId") walletId: string) {
        // Id que nem é UUID não pode existir: 404 direto, sem ir ao banco.
        const wallet = isUuid(walletId) ? await this.queries.getWallet(walletId) : null;
        if (!wallet) throw new NotFoundException(`Wallet ${walletId} not found`);
        return presentWallet(wallet);
    }

    /** Sempre 200 quando a wallet existe: divergência vem sinalizada em `consistent: false`. */
    @Post(":walletId/reconciliation")
    @HttpCode(200)
    async reconcile(@Param("walletId") walletId: string) {
        const result = isUuid(walletId) ? await this.reconcileWallet.execute(walletId) : null;
        if (!result) throw new NotFoundException(`Wallet ${walletId} not found`);
        return result; // Money vira { amount, currency } no JSON
    }

    @Get(":walletId/ledger")
    async ledger(
        @Param("walletId") walletId: string,
        @Query("cursor") cursor?: string,
        @Query("limit") limit?: string,
    ) {
        const page = isUuid(walletId)
            ? await this.queries.getLedger(walletId, parseCursor(cursor), parseLimit(limit))
            : null;
        if (!page) throw new NotFoundException(`Wallet ${walletId} not found`);

        return {
            items: page.entries.map(presentLedgerEntry),
            nextCursor: page.nextCursor ? ledgerCursor.encode(page.nextCursor) : null,
        };
    }
}

function parseCursor(cursor: string | undefined): string | undefined {
    if (cursor === undefined || cursor === "") return undefined;
    const seq = ledgerCursor.decode(cursor);
    if (seq === undefined) throw new InvalidInputError(["cursor is invalid"]);
    return seq;
}

function parseLimit(limit: string | undefined): number {
    if (limit === undefined || limit === "") return DEFAULT_LEDGER_LIMIT;
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LEDGER_LIMIT) {
        throw new InvalidInputError([`limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`]);
    }
    return n;
}
