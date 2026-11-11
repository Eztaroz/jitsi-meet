/**
 * Opens the store the deployment's settings name: MariaDB when `COORDINATOR_MARIADB_HOST` is set, SQLite in the data
 * directory otherwise.
 */
import type { IConfig } from './config.ts';
import { MariaDbStore } from './mariadbStore.ts';
import { type IStore, Store } from './store.ts';

/**
 * Opens the store.
 *
 * @param {Pick<IConfig, 'dataDir' | 'database'>} config - The settings.
 * @returns {IStore}
 */
export function openStore(config: Pick<IConfig, 'dataDir' | 'database'>): IStore {
    return config.database ? new MariaDbStore(config.database) : new Store(config.dataDir);
}
