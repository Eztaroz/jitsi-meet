/**
 * The databases the store suite runs against: SQLite always, and MariaDB when `COORDINATOR_TEST_MARIADB` names one, as
 * `mariadb://user:password@host:port/schema`. The suite drops every table of that schema before each test, so point it
 * at a schema made for tests, never at a real one. The pipeline gives it a MariaDB service container.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConnection } from 'mariadb';

import { type IMariaDbConfig, MariaDbStore } from '../src/mariadbStore.ts';
import { type IStore, Store } from '../src/store.ts';

export interface IBackend {

    /** Closes every store this backend opened. */
    closeAll(): void;

    /** Makes an empty database, and returns a function that opens it: each call is one more instance on the same data. */
    fresh(): Promise<() => IStore>;
    name: string;
}

/**
 * Reads the MariaDB under test from the environment.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @returns {IMariaDbConfig | undefined} Unset when there is no MariaDB to test against.
 */
export function testMariaDb(env: NodeJS.ProcessEnv = process.env): IMariaDbConfig | undefined {
    if (!env.COORDINATOR_TEST_MARIADB) {
        return undefined;
    }
    const url = new URL(env.COORDINATOR_TEST_MARIADB);

    return {
        database: decodeURIComponent(url.pathname.slice(1)),
        host: url.hostname,
        password: decodeURIComponent(url.password),
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username)
    };
}

/**
 * Drops every table of the schema.
 *
 * @param {IMariaDbConfig} config - The schema.
 * @returns {Promise<void>}
 */
export async function wipeMariaDb(config: IMariaDbConfig): Promise<void> {
    const connection = await createConnection(config);

    try {
        const tables = await connection.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()') as
            { name: string; }[];

        await connection.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const { name } of tables) {
            await connection.query(`DROP TABLE \`${name}\``);
        }
    } finally {
        await connection.end();
    }
}

/**
 * Lists the backends to run the store suite against.
 *
 * @returns {IBackend[]}
 */
export function backends(): IBackend[] {
    const list: IBackend[] = [];
    let opened: IStore[] = [];
    const track = (store: IStore) => {
        opened.push(store);

        return store;
    };
    const closeAll = () => {
        for (const store of opened) {
            try {
                store.close();
            } catch {
                // Closed by the test already.
            }
        }
        opened = [];
    };

    list.push({
        closeAll,
        fresh: async () => {
            const dir = mkdtempSync(join(tmpdir(), 'store-'));

            return () => track(new Store(dir));
        },
        name: 'SQLite'
    });

    const mariadb = testMariaDb();

    if (mariadb) {
        list.push({
            closeAll,
            fresh: async () => {
                await wipeMariaDb(mariadb);

                return () => track(new MariaDbStore(mariadb));
            },
            name: 'MariaDB'
        });
    }

    return list;
}
