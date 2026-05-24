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
 * Builds runtime TypeORM options for SQLite in WAL mode (TRD §10.2, §16).
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
