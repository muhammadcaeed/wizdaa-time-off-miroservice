import { DataSource } from 'typeorm';
import {
  AuditLog,
  Balance,
  Employee,
  IdempotencyRecord,
  Location,
  Reconciliation,
  TimeOffRequest,
} from '../../apps/time-off-service/src/database/entities';
import { InitSchema1779625818136 } from '../../apps/time-off-service/src/database/migrations/1779625818136-InitSchema';

/**
 * Builds an in-memory SQLite DataSource for integration tests and applies the
 * committed migration (never `synchronize`, per requirements.md §2.3). Each call
 * yields an isolated schema bound to a single better-sqlite3 connection.
 */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    synchronize: false,
    entities: [
      Employee,
      Location,
      Balance,
      TimeOffRequest,
      AuditLog,
      IdempotencyRecord,
      Reconciliation,
    ],
    migrations: [InitSchema1779625818136],
  });
  await dataSource.initialize();
  await dataSource.runMigrations();
  return dataSource;
}
