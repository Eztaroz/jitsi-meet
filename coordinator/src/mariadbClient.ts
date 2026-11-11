/**
 * Calls MariaDB synchronously. The service decides from its state in memory and writes each change before it goes on,
 * so its store is synchronous; the driver is not. The driver therefore runs in a worker thread, and a call blocks
 * this thread until the worker has answered. Writes are small, so the wait is a few milliseconds.
 */
import { MessageChannel, type MessagePort, Worker, receiveMessageOnPort } from 'node:worker_threads';

import type { IMariaDbConfig } from './mariadbStore.ts';
import type { IStatement, Request, Response, StatementResult } from './mariadbWorker.ts';

/** How long a call waits for the database before it fails. */
const CALL_TIMEOUT_MS = 30_000;

/** What MariaDB refused, or that it could not be reached. */
export class DatabaseError extends Error {
    readonly code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.name = 'DatabaseError';
        this.code = code;
    }
}

export class MariaDbClient {
    private _closed = false;
    private readonly _port: MessagePort;
    private readonly _signal: Int32Array;
    private readonly _worker: Worker;

    /**
     * Starts the worker. The connection is made by the first call.
     *
     * @param {IMariaDbConfig} config - Where the database is.
     */
    constructor(config: IMariaDbConfig) {
        const { port1, port2 } = new MessageChannel();

        this._port = port1;
        this._signal = new Int32Array(new SharedArrayBuffer(4));
        this._worker = new Worker(new URL('./mariadbWorker.ts', import.meta.url), {
            transferList: [ port2 ],
            workerData: { config, port: port2, signal: this._signal }
        });

        // Neither the worker nor the port keeps the process alive on their own.
        this._worker.unref();
        this._port.unref();
    }

    /**
     * Runs one statement.
     *
     * @param {string} sql - The statement, with `?` for each parameter.
     * @param {unknown[]} params - The parameters.
     * @returns {StatementResult} The rows of a select, or how many rows were changed.
     */
    query(sql: string, params: unknown[] = []): StatementResult {
        return this._call({ op: 'query', statement: { params, sql } })[0];
    }

    /**
     * Reads rows.
     *
     * @param {string} sql - The select, with `?` for each parameter.
     * @param {unknown[]} params - The parameters.
     * @returns {Object[]} The rows.
     */
    select<T>(sql: string, params: unknown[] = []): T[] {
        const result = this.query(sql, params);

        return 'rows' in result ? result.rows as T[] : [];
    }

    /**
     * Runs statements, in order, in one transaction: all of them are saved or none.
     *
     * @param {IStatement[]} statements - The statements.
     * @returns {StatementResult[]} What each gave.
     */
    batch(statements: IStatement[]): StatementResult[] {
        return statements.length ? this._call({ op: 'batch', statements }) : [];
    }

    /**
     * Closes the connection and stops the worker.
     *
     * @returns {void}
     */
    close(): void {
        if (this._closed) {
            return;
        }
        try {
            this._call({ op: 'close' });
        } finally {
            this._closed = true;
            this._port.close();
            this._worker.terminate();
        }
    }

    /**
     * Sends a request and waits for the answer.
     *
     * @param {Request} request - The request.
     * @returns {StatementResult[]}
     */
    private _call(request: Request): StatementResult[] {
        if (this._closed) {
            throw new DatabaseError('the database is closed');
        }
        Atomics.store(this._signal, 0, 0);
        this._port.postMessage(request);

        if (Atomics.wait(this._signal, 0, 0, CALL_TIMEOUT_MS) === 'timed-out') {
            throw new DatabaseError('the database did not answer in time');
        }

        const received = receiveMessageOnPort(this._port);
        const response = received?.message as Response | undefined;

        if (!response) {
            throw new DatabaseError('the database gave no answer');
        }
        if (!response.ok) {
            throw new DatabaseError(response.error.message, response.error.code);
        }

        return response.results;
    }
}
