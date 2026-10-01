import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { isSafeText, isUuid, parseWagerTransactionInput } from "../application/input-validation";
import { WageringQueries } from "../application/queries";
import { ProcessWagerTransaction } from "../application/use-cases/process-wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction/wager-transaction";
import { AuthGuard } from "./auth.guard";
import { presentProcessResult, presentTransaction } from "./presenters";

/** Status HTTP de cada desfecho gravado. Replay devolve o mesmo status do original. */
const STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
    [WagerTransactionStatus.Processed]: 200,
    [WagerTransactionStatus.PendingReference]: 202, // aceito, aplica quando a referência chegar
    [WagerTransactionStatus.Pending]: 202,
    [WagerTransactionStatus.Rejected]: 422, // decisão final de negócio (vem com failureCode)
    [WagerTransactionStatus.Failed]: 422,
};

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
    constructor(
        @Inject(ProcessWagerTransaction) private readonly processTransaction: ProcessWagerTransaction,
        @Inject(WageringQueries) private readonly queries: WageringQueries,
    ) { }

    @Post("wagering/transactions")
    async submit(
        @Headers("idempotency-key") idempotencyKey: string | undefined,
        @Body() body: unknown,
        @Res({ passthrough: true }) res: Response,
    ) {
        const result = await this.processTransaction.execute(parseWagerTransactionInput(body, idempotencyKey));
        res.status(STATUS_BY_RESULT[result.status]);
        return presentProcessResult(result);
    }

    @Get("wagering/transactions/:transactionId")
    async getById(@Param("transactionId") transactionId: string) {
        const tx = isUuid(transactionId) ? await this.queries.getTransaction(transactionId) : null;
        if (!tx) throw new NotFoundException(`Transaction ${transactionId} not found`);
        return presentTransaction(tx);
    }

    @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
    async getByExternalId(
        @Param("providerId") providerId: string,
        @Param("externalTransactionId") externalTransactionId: string,
    ) {
        // Texto que nunca passaria na validação de entrada não pode existir (e um NUL quebraria a query).
        const tx = isSafeText(providerId) && isSafeText(externalTransactionId)
            ? await this.queries.getTransactionByExternalId(providerId, externalTransactionId)
            : null;
        if (!tx) throw new NotFoundException(`Transaction ${externalTransactionId} from ${providerId} not found`);
        return presentTransaction(tx);
    }
}
