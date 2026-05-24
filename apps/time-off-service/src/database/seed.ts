import jwt from 'jsonwebtoken';
import dataSource from './data-source';
import { Balance, Employee, Location } from './entities';

/**
 * Dev-only manual-testing seed. NOT part of the cycle deliverable — it inserts a
 * minimal org (one location, one manager, one report, one balance) and prints
 * ready-to-paste bearer tokens. Run after `npm run migration:run`.
 *
 * Tokens are signed with JWT_SIGNING_KEY from the environment, so the running
 * service (same .env) verifies them.
 */
async function main(): Promise<void> {
  const signingKey = process.env.JWT_SIGNING_KEY;
  if (!signingKey) {
    throw new Error('JWT_SIGNING_KEY is unset — load your .env before seeding.');
  }

  await dataSource.initialize();
  const locations = dataSource.getRepository(Location);
  const employees = dataSource.getRepository(Employee);
  const balances = dataSource.getRepository(Balance);

  // Idempotent-ish: wipe the small seed set so re-runs are clean.
  await balances.delete({ id: 'bal_001' });
  await employees.delete({ id: 'emp_001' });
  await employees.delete({ id: 'mgr_001' });
  await locations.delete({ id: 'loc_001' });

  await locations.insert({ id: 'loc_001', name: 'HQ', countryCode: 'US' });
  await employees.insert({
    id: 'mgr_001',
    email: 'manager@example.com',
    firstName: 'Mona',
    lastName: 'Manager',
    locationId: 'loc_001',
    managerId: null,
  });
  await employees.insert({
    id: 'emp_001',
    email: 'employee@example.com',
    firstName: 'Eddie',
    lastName: 'Employee',
    locationId: 'loc_001',
    managerId: 'mgr_001',
  });
  await balances.insert({
    id: 'bal_001',
    employeeId: 'emp_001',
    locationId: 'loc_001',
    totalDays: 20,
    reservedDays: 0,
    version: 0,
  });

  const token = (sub: string, roles: string[]): string =>
    jwt.sign({ sub, roles }, signingKey, { algorithm: 'HS256', expiresIn: 86400 });

  console.log('\nSeeded: loc_001, mgr_001 (manager of emp_001), emp_001, bal_001 (20 days).\n');
  console.log('export EMP_TOKEN="' + token('emp_001', ['EMPLOYEE']) + '"');
  console.log('export MGR_TOKEN="' + token('mgr_001', ['MANAGER']) + '"');
  console.log('export ADMIN_TOKEN="' + token('admin_001', ['ADMIN']) + '"\n');

  await dataSource.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
