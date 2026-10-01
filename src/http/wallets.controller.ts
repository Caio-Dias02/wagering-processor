import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { InvalidInputError, isUuid, parseCreateWalletInput } from "../application/input-validation";
import { WageringQueries } from "../application/queries";
import { CreateWallet } from "../application/use-cases/create-wallet";
import { AuthGuard } from "./auth.guard";
import { ledgerCursor, presentLedgerEntry, presentWallet } from "./presenters";

const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 200;

@Controller("wallets")
@UseGuards(AuthGuard)
export class WalletsController {
    constructor(
        @Inject(CreateWallet) private readonly createWallet: CreateWallet,
        @Inject(WageringQueries) private readonly queries: WageringQueries,
    ) { }

    @Post()
    @HttpCode(201)
    async create(@Body() body: unknown) {
        const wallet = await this.createWallet.execute(parseCreateWalletInput(body));
        return presentWallet(wallet);
    }

    @Get(":walletId")
    async get(@Param("walletId") walletId: string) {
        // Id que nem é UUID não pode existir: 404 direto, sem ir ao banco.
        const wallet = isUuid(walletId) ? await this.queries.getWallet(walletId) : null;
        if (!wallet) throw new NotFoundException(`Wallet ${walletId} not found`);
        return presentWallet(wallet);
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
