import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";
import config from "./mikro-orm.config";

/** Token de injeção da porta UnitOfWork (interfaces não existem em runtime). */
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

/** Fecha o pool de conexões quando a aplicação desliga (SIGTERM). */
@Injectable()
class OrmShutdown implements OnApplicationShutdown {
    constructor(@Inject(MikroORM) private readonly orm: MikroORM) { }

    async onApplicationShutdown(): Promise<void> {
        await this.orm.close();
    }
}

@Global()
@Module({
    providers: [
        { provide: MikroORM, useFactory: () => MikroORM.init(config) },
        { provide: UNIT_OF_WORK, inject: [MikroORM], useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm) },
        OrmShutdown,
    ],
    exports: [MikroORM, UNIT_OF_WORK],
})
export class DatabaseModule { }
