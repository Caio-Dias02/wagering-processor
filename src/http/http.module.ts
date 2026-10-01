import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { Observability } from "../application/ports/observability";
import type { UnitOfWork } from "../application/ports/repositories";
import { WageringQueries } from "../application/queries";
import { CreateWallet } from "../application/use-cases/create-wallet";
import { ProcessWagerTransaction } from "../application/use-cases/process-wager-transaction";
import { ReconcileWallet } from "../application/use-cases/reconcile-wallet";
import { UNIT_OF_WORK } from "../infrastructure/database/database.module";
import { OBSERVABILITY } from "../infrastructure/observability/observability.module";
import { AuthGuard, NoAuthProviderIdentity, PROVIDER_IDENTITY } from "./auth.guard";
import { HttpErrorFilter } from "./http-error.filter";
import { RequestContextMiddleware } from "./request-context.middleware";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

// Os casos de uso não conhecem o Nest (sem decorators): são montados aqui, por factory.
const useCase = <T>(type: new (uow: UnitOfWork, observability: Observability) => T) => ({
    provide: type,
    inject: [UNIT_OF_WORK, OBSERVABILITY],
    useFactory: (uow: UnitOfWork, observability: Observability) => new type(uow, observability),
});

@Module({
    controllers: [WalletsController, WageringController],
    providers: [
        { provide: CreateWallet, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new CreateWallet(uow) },
        { provide: WageringQueries, inject: [UNIT_OF_WORK], useFactory: (uow: UnitOfWork) => new WageringQueries(uow) },
        useCase(ProcessWagerTransaction),
        useCase(ReconcileWallet),
        { provide: PROVIDER_IDENTITY, useClass: NoAuthProviderIdentity },
        AuthGuard,
        { provide: APP_FILTER, useClass: HttpErrorFilter },
    ],
})
export class HttpModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(RequestContextMiddleware).forRoutes("*");
    }
}
