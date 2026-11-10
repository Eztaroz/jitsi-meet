---
status: accepted
---

# The coordinator service keeps its state in a separate MariaDB, with one active instance

The coordinator service keeps encounters, moves, the audit log and the satisfaction surveys in SQLite, in a file on its own host. That host is then the one place whose loss loses them, and the service cannot be started on another VM. The state moves to a **MariaDB on its own VM**, which the hospital's database team already runs and backs up. It is never the hospital system's own database.

The coordinator service still holds the state in memory and decides from it; the database is where it is kept. So only **one instance is active** at a time: an instance becomes active by taking a lock in the database, and a standby on another VM waits for that lock and takes over when the active one is gone. The service writes only what changed (an encounter, a move, an audit entry), in order, rather than the whole state at every change.

## Considered options

- **Stay on SQLite** and back up the file. This was rejected because the service could not move to another VM while its host is down.
- **PostgreSQL.** It has advisory locks and JSON columns, but the hospital's team runs MariaDB, with backups in place, and MariaDB's named locks are enough.
- **Several active instances sharing the database.** This was rejected because the service decides from its state in memory: two instances would decide from two different states.

## Consequences

- The coordinator service gets its first dependency, the MariaDB driver; until now it ran on Node.js alone. SQLite stays for the tests and for a deployment on one host.
- When the database cannot be written, the coordinator service refuses what must be audited (starting an encounter, changing a stage, a move), rather than doing it without a record.
- The lock is there from the start, but a standby VM is added only when it is needed.
- A one-off migration copies a deployment's SQLite file into the database.
- The coordinator service changes its own schema: when it starts, it applies the numbered migrations the database has not had yet. Its database user may change its own schema and nothing else, so the database team does not run a script at each release.
- The consultations get a table: which encounter, which recorder bot, and whether it is recording, so that a lost recorder bot's consultation can be taken over (ADR 0016) and an evidence recording found from its encounter.
- The list of workers (ADR 0014) is not in the database.
