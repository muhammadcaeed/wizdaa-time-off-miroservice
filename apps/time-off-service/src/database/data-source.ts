import { join } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import {
  AuditLog,
  Balance,
  Employee,
  IdempotencyRecord,
  Location,
  Reconciliation,
  TimeOffRequest,
} from './entities';

const DEFAULT_DATABASE_FILE = './data/time-off.sqlite';

/**
 * Milliseconds a writer waits on a held lock before SQLITE_BUSY. Cycle-04's
 * per-row reconciliation transactions contend with saga writers, and WAL still
 * permits only ONE writer at a time; without a busy timeout a brief overlap
 * fails immediately instead of waiting out the other writer.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Minimal view of the better-sqlite3 connection handed to `prepareDatabase`.
 * The driver types the callback param as `any`; narrowing it here keeps the
 * `db.pragma(...)` call typed (no `any` leak) per the no-`any` rule.
 */
interface PragmaCapable {
  pragma(source: string): unknown;
}

/**
 * Builds runtime TypeORM options for SQLite in WAL mode (TRD §10.2, §15).
 * `synchronize` is never enabled; schema changes go through committed
 * migrations only (requirements.md §2.3). Migrations are deliberately omitted
 * here — the running app does not load them; they are applied via the CLI
 * (`migration:*` scripts) using the default export below.
 */
export function buildDataSourceOptions(
  databaseFile: string = process.env.DATABASE_FILE ?? DEFAULT_DATABASE_FILE,
): DataSourceOptions {
  return {
    type: 'better-sqlite3',
    database: databaseFile,
    synchronize: false,
    // SQLite write-ahead logging for the concurrency model (TRD §10.2).
    enableWAL: true,
    // Wait out a concurrent writer's lock rather than failing fast on
    // SQLITE_BUSY (see SQLITE_BUSY_TIMEOUT_MS rationale above).
    prepareDatabase: (db: PragmaCapable) => {
      db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    },
    entities: [
      Employee,
      Location,
      Balance,
      TimeOffRequest,
      AuditLog,
      IdempotencyRecord,
      Reconciliation,
    ],
  };
}

/** Default DataSource consumed by the TypeORM CLI (migration:* scripts). */
export default new DataSource({
  ...buildDataSourceOptions(),
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
});
