import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { entities } from "./entities/index";

export default defineConfig({
    clientUrl:
        process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering",
    // Conexões por instância. Cada transação segura uma enquanto a wallet está travada,
    // então o pool é o teto de transações simultâneas da instância.
    pool: { min: 2, max: Number(process.env.DATABASE_POOL_MAX ?? 10) },
    entities,
    preferTs: true,
    extensions: [Migrator],
    migrations: {
        path: "src/infrastructure/database/migrations",
        pathTs: "src/infrastructure/database/migrations",
        glob: "!(*.d).{js,ts}",
        transactional: true,
        allOrNothing: true,
    },
});