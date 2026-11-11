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

/** What the client can be told besides where the database is. */
export interface IMariaDbClientOptions {

    /** How long a call waits for the database before it fails. */
    callTimeoutMs?: number;
}

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
    private readonly _callTimeoutMs: number;
    private _closed = false;
    private _nextId = 1;
    private readonly _port: MessagePort;
    private readonly _signal: Int32Array;
    private readonly _worker: Worker;

    /**
     * Starts the worker. The connection is made by the first call.
     *
     * @param {IMariaDbConfig} config - Where the database is.
     * @param {IMariaDbClientOptions} options - How long a call may wait.
     */
    constructor(config: IMariaDbConfig, options: IMariaDbClientOptions = {}) {
        this._callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
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
        const id = this._nextId++;
        const deadline = Date.now() + this._callTimeoutMs;

        this._port.postMessage({ ...request, id });

        // The worker counts each answer it posts. An answer to an earlier call that timed out may still arrive; it
        // carries another id and is dropped, so a late answer is never taken for this call's.
        let response: Response | undefined;

        while (!response) {
            const seen = Atomics.load(this._signal, 0);
            let received = receiveMessageOnPort(this._port);

            while (received) {
                const message = received.message as Response;

                if (message.id === id) {
                    response = message;
                    break;
                }
                received = receiveMessageOnPort(this._port);
            }
            if (response) {
                break;
            }

            const left = deadline - Date.now();

            if (left <= 0 || Atomics.wait(this._signal, 0, seen, left) === 'timed-out') {
                throw new DatabaseError('the database did not answer in time');
            }
        }

        if (!response.ok) {
            throw new DatabaseError(response.error.message, response.error.code);
        }

        return response.results;
    }
}
