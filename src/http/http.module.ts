import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { UnitOfWork } from "../application/ports/repositories";
import { WageringQueries } from "../application/queries";
import { CreateWallet } from "../application/use-cases/create-wallet";
import { ProcessWagerTransaction } from "../application/use-cases/process-wager-transaction";
import { UNIT_OF_WORK } from "../infrastructure/database/database.module";
import { AuthGuard, NoAuthProviderIdentity, PROVIDER_IDENTITY } from "./auth.guard";
import { HttpErrorFilter } from "./http-error.filter";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

// Os casos de uso não conhecem o Nest (sem decorators): são montados aqui, por factory.
const useCase = <T>(type: new (uow: UnitOfWork) => T) => ({
    provide: type,
    inject: [UNIT_OF_WORK],
    useFactory: (uow: UnitOfWork) => new type(uow),
});

@Module({
    controllers: [WalletsController, WageringController],
    providers: [
        useCase(CreateWallet),
        useCase(ProcessWagerTransaction),
        useCase(WageringQueries),
        { provide: PROVIDER_IDENTITY, useClass: NoAuthProviderIdentity },
        AuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
    ],
})
export class HttpModule { }
