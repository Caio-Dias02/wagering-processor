import { MikroORM } from "@mikro-orm/postgresql";
import config from "../src/infrastructure/database/mikro-orm.config.ts";

const command = process.argv[2] ?? "up";
const orm = await MikroORM.init(config);

try {
    const migrator = orm.getMigrator();

    switch (command) {
        case "up":
            await migrator.up();
            break;
        case "down":
            await migrator.down();
            break;
        case "create": {
            // gera a migration comparando as entidades com o banco
            const result = await migrator.createMigration();
            console.log(result.fileName ? `📝 criada: ${result.fileName}` : "nenhuma mudança");
            break;
        }
        case "create:blank": {
            // cria uma migration vazia, para SQL escrito à mão
            const result = await migrator.createMigration(undefined, true);
            console.log(`📝 criada: ${result.fileName}`);
            break;
        }
        default:
            throw new Error(`comando desconhecido: ${command}`);
    }

    console.log(`✅ ${command}: ok`);
} finally {
    await orm.close(true);
}