/**
 * The one-off command that moves a deployment from SQLite to MariaDB (ADR 0015): it copies every encounter, move,
 * audit entry, survey and consultation of the SQLite file into the MariaDB the `COORDINATOR_MARIADB_*` settings name.
 * Stop the coordinator service first, so that nothing is written to the file meanwhile.
 *
 *   node src/copySqliteToMariadb.ts [<data directory>]
 *
 * The data directory is the one holding `coordinator.sqlite`: `COORDINATOR_DATA_DIR`, or `/var/lib/coordinator`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { mariaDbConfig } from './config.ts';
import { copyStore } from './copyStore.ts';
import { MariaDbStore } from './mariadbStore.ts';
import { Store } from './store.ts';

const dir = process.argv[2] || process.env.COORDINATOR_DATA_DIR?.trim() || '/var/lib/coordinator';
const file = join(dir, 'coordinator.sqlite');

if (!existsSync(file)) {
    process.stderr.write(`There is no SQLite database at ${file}\n`);
    process.exit(1);
}

const source = new Store(dir);
let target: MariaDbStore | undefined;

try {
    target = new MariaDbStore(mariaDbConfig(process.env));

    const counts = copyStore(source, target);

    process.stdout.write(`Copied ${counts.encounters} encounters, ${counts.moves} moves, ${counts.audit} audit entries, `
        + `${counts.surveys} surveys and ${counts.consultations} consultations from ${file}.\n`);
} catch (error) {
    process.stderr.write(`Nothing was copied: ${(error as Error).message}\n`);
    process.exitCode = 1;
} finally {
    source.close();
    target?.close();
}
