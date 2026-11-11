/**
 * The numbered schema migrations of the coordinator service's MariaDB (ADR 0015). The service applies the ones the
 * database has not had yet when it starts, and records each in `schema_migrations`, so its database user needs rights
 * on its own schema only and nobody runs a script at a release.
 *
 * Never edit a migration that has been released: add a new one at the end, with the next number.
 *
 * Dates are kept as ISO 8601 text in UTC, as in SQLite, so that they compare as text and read back the same.
 */
import type { MariaDbClient } from './mariadbClient.ts';

export interface IMigration {

    /** The number, from 1 and without gaps. */
    id: number;
    name: string;
    statements: string[];
}

const TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

export const MIGRATIONS: IMigration[] = [
    {
        id: 1,
        name: 'the first schema: encounters, moves, audit entries, surveys and consultations',
        statements: [
            `CREATE TABLE encounters (
                id VARCHAR(255) NOT NULL PRIMARY KEY,
                hn VARCHAR(255) NOT NULL,
                stage VARCHAR(255) NOT NULL,
                started_at VARCHAR(30) NOT NULL,
                stage_started_at VARCHAR(30) NULL,
                history LONGTEXT NULL,
                unfinished TINYINT NULL,
                pathway VARCHAR(255) NULL,
                visit_number VARCHAR(255) NULL,
                center VARCHAR(255) NULL,
                clinic VARCHAR(255) NULL,
                doctor VARCHAR(255) NULL,
                questionnaires LONGTEXT NULL,
                videos LONGTEXT NULL,
                KEY encounters_started_at (started_at)
            ) ${TABLE}`,
            `CREATE TABLE audit (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                at VARCHAR(30) NOT NULL,
                entry LONGTEXT NOT NULL,
                KEY audit_at (at)
            ) ${TABLE}`,
            `CREATE TABLE moves (
                id VARCHAR(255) NOT NULL PRIMARY KEY,
                started_at VARCHAR(30) NOT NULL,
                move LONGTEXT NOT NULL,
                record LONGTEXT NOT NULL,
                KEY moves_started_at (started_at)
            ) ${TABLE}`,
            `CREATE TABLE patient_rooms (
                identity_id VARCHAR(255) NOT NULL PRIMARY KEY,
                room VARCHAR(255) NOT NULL,
                updated_at VARCHAR(30) NOT NULL
            ) ${TABLE}`,
            `CREATE TABLE staff_stations (
                identity_id VARCHAR(255) NOT NULL PRIMARY KEY,
                station VARCHAR(255) NOT NULL,
                updated_at VARCHAR(30) NOT NULL
            ) ${TABLE}`,
            `CREATE TABLE surveys (
                id VARCHAR(255) NOT NULL PRIMARY KEY,
                submitted_at VARCHAR(30) NOT NULL,
                survey LONGTEXT NOT NULL,
                KEY surveys_submitted_at (submitted_at)
            ) ${TABLE}`,
            `CREATE TABLE consultations (
                id VARCHAR(255) NOT NULL PRIMARY KEY,
                encounter_id VARCHAR(255) NOT NULL,
                recorder_bot VARCHAR(255) NOT NULL,
                recording TINYINT NOT NULL,
                started_at VARCHAR(30) NOT NULL,
                KEY consultations_encounter (encounter_id),
                KEY consultations_started_at (started_at)
            ) ${TABLE}`
        ]
    }
];

/** The name of the lock that keeps two instances from migrating at the same moment. */
const MIGRATION_LOCK = 'coordinator_schema_migrations';

/**
 * Applies the migrations the database has not had yet, in order, and records each.
 *
 * MariaDB cannot roll a schema change back, so a migration that fails half-way stops the start and is not recorded:
 * fix it by hand, as the database team would any failed change.
 *
 * @param {MariaDbClient} client - The connection.
 * @param {IMigration[]} migrations - The migrations; the service's own, unless a test brings others.
 * @returns {number[]} The numbers of those applied now.
 */
export function applyMigrations(client: MariaDbClient, migrations: IMigration[] = MIGRATIONS): number[] {
    // A standby instance that starts with the active one waits here until the other is done, and then finds nothing to do.
    const [ { got } ] = client.select<{ got: number; }>('SELECT GET_LOCK(?, 60) AS got', [ MIGRATION_LOCK ]);

    if (Number(got) !== 1) {
        throw new Error('another instance is migrating the database and did not finish in time');
    }

    try {
        client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            id INT NOT NULL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            applied_at VARCHAR(30) NOT NULL
        ) ${TABLE}`);

        const done = new Set(client.select<{ id: number; }>('SELECT id FROM schema_migrations').map(r => Number(r.id)));
        const applied: number[] = [];

        for (const migration of migrations) {
            if (done.has(migration.id)) {
                continue;
            }
            for (const sql of migration.statements) {
                client.query(sql);
            }
            client.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
                [ migration.id, migration.name, new Date().toISOString() ]);
            applied.push(migration.id);
        }

        return applied;
    } finally {
        client.query('SELECT RELEASE_LOCK(?)', [ MIGRATION_LOCK ]);
    }
}
