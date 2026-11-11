/**
 * Runs in a worker thread: owns the one MariaDB connection and answers `MariaDbClient`'s requests, so that the
 * coordinator service, which decides from its state in memory and calls its store synchronously, can use the driver,
 * which is asynchronous. One connection, so that a named lock taken on it is held until it closes.
 */
import { type MessagePort, workerData } from 'node:worker_threads';

import { type Connection, createConnection } from 'mariadb';

import type { IMariaDbConfig } from './mariadbStore.ts';

export interface IStatement {
    params?: unknown[];
    sql: string;
}

export type Request =
    | { op: 'batch'; statements: IStatement[]; }
    | { op: 'close'; }
    | { op: 'query'; statement: IStatement; };

/** A request as sent: the client numbers each one, and the answer carries the number back. */
export type NumberedRequest = Request & { id: number; };

/** What one statement gave: the rows of a select, or how many rows an insert, update or delete changed. */
export type StatementResult = { affectedRows: number; } | { rows: Record<string, unknown>[]; };

export type Response =
    | { error: { code?: string; fatal?: boolean; message: string; }; id: number; ok: false; }
    | { id: number; ok: true; results: StatementResult[]; };

const { config, port, signal } = workerData as { config: IMariaDbConfig; port: MessagePort; signal: Int32Array; };
/** A statement the database has not finished by now is abandoned, a little before the client gives up waiting. */
const QUERY_TIMEOUT_MS = 25_000;
let connection: Connection | undefined;

/**
 * Gives the connection, opening it when there is none.
 *
 * @returns {Promise<Connection>}
 */
async function connected(): Promise<Connection> {
    if (!connection) {
        connection = await createConnection({
            bigIntAsNumber: true,
            charset: 'utf8mb4',
            connectTimeout: 10_000,
            queryTimeout: QUERY_TIMEOUT_MS,
            database: config.database,
            decimalAsNumber: true,
            host: config.host,
            insertIdAsNumber: true,
            password: config.password,
            port: config.port,
            user: config.user
        });
        connection.on('error', () => {
            connection = undefined;
        });
    }

    return connection;
}

/**
 * Runs one statement.
 *
 * @param {Connection} conn - The connection.
 * @param {IStatement} statement - The statement.
 * @returns {Promise<StatementResult>}
 */
async function run(conn: Connection, statement: IStatement): Promise<StatementResult> {
    const result = await conn.query(statement.sql, statement.params ?? []);

    return Array.isArray(result)
        ? { rows: result.map(row => ({ ...row })) }
        : { affectedRows: Number((result as { affectedRows: number | bigint; }).affectedRows) };
}

/**
 * Answers a request.
 *
 * @param {Request} request - The request.
 * @returns {Promise<StatementResult[]>}
 */
async function handle(request: Request): Promise<StatementResult[]> {
    if (request.op === 'close') {
        await connection?.end();
        connection = undefined;

        return [];
    }

    const conn = await connected();

    if (request.op === 'query') {
        return [ await run(conn, request.statement) ];
    }

    // All of them are saved or none.
    await conn.beginTransaction();
    try {
        const results: StatementResult[] = [];

        for (const statement of request.statements) {
            results.push(await run(conn, statement));
        }
        await conn.commit();

        return results;
    } catch (error) {
        await conn.rollback().catch(() => undefined);
        throw error;
    }
}

port.on('message', async (request: NumberedRequest) => {
    let response: Response;

    try {
        response = { id: request.id, ok: true, results: await handle(request) };
    } catch (error) {
        const { code, fatal, message } = error as { code?: string; fatal?: boolean; message: string; };

        if (fatal) {
            connection = undefined;
        }
        response = { error: { code, fatal, message }, id: request.id, ok: false };
    }

    // The answer is in the port's queue before the caller is woken.
    port.postMessage(response);
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
});
