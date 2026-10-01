import type { EntityManager } from "@mikro-orm/postgresql";
import type { ScheduledJobRepository } from "../../../application/ports/repositories";

export class MikroOrmScheduledJobRepository implements ScheduledJobRepository {
    constructor(private readonly em: EntityManager) { }

    async tryStart(name: string, minIntervalMs: number): Promise<boolean> {
        // Uma instrução atômica: a primeira execução cria a linha; as seguintes só
        // atualizam se o intervalo já passou. Duas instâncias ao mesmo tempo: a segunda
        // espera a primeira e, ao reavaliar o WHERE com a linha nova, não atualiza nada.
        const rows = await this.em.getConnection().execute<{ name: string }[]>(
            `insert into scheduled_jobs (name, last_started_at) values (?, now())
             on conflict (name) do update set last_started_at = excluded.last_started_at
              where scheduled_jobs.last_started_at <= now() - (? * interval '1 millisecond')
             returning name`,
            [name, minIntervalMs],
            "all",
            this.em.getTransactionContext(),
        );
        return rows.length === 1;
    }
}
