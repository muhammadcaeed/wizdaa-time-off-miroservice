import 'reflect-metadata';
import { type ChildProcess, spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../apps/time-off-service/src/database/data-source';
import { Balance, Employee, Location } from '../../apps/time-off-service/src/database/entities';
import { InitSchema1779625818136 } from '../../apps/time-off-service/src/database/migrations/1779625818136-InitSchema';
import { AddRequestListIndexes1779660850392 } from '../../apps/time-off-service/src/database/migrations/1779660850392-AddRequestListIndexes';

const REPO_ROOT = join(__dirname, '..', '..');
const SIGNING_KEY = 'demo-signing-key-not-a-secret';
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

/** A seeded actor and its bearer token. */
export interface Actor {
  readonly sub: string;
  readonly token: string;
}

export interface DemoActors {
  readonly employee: Actor;
  readonly manager: Actor;
  readonly admin: Actor;
}

/** Fixed demo identities — stable so the rendered showcase is deterministic. */
export const IDS = {
  employee: 'emp_demo',
  manager: 'mgr_demo',
  admin: 'adm_demo',
  location: 'loc_demo',
} as const;

function mintToken(sub: string, roles: string[]): string {
  return jwt.sign({ sub, roles }, SIGNING_KEY, { algorithm: 'HS256', expiresIn: 3600 });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, label: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${label} not ready after ${READY_TIMEOUT_MS}ms`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Boots a throwaway time-off-service + mock-hcm pair against a temp SQLite DB,
 * seeds a minimal org and matching local/HCM balances, and exposes typed HTTP
 * helpers. {@link stop} tears both processes down and removes the temp dir; it
 * is registered on process exit and signals so a crash never orphans children.
 */
export class DemoHarness {
  private tmpDir!: string;
  private dbFile!: string;
  private service?: ChildProcess;
  private mock?: ChildProcess;
  private stopped = false;

  svcBase!: string;
  mockBase!: string;
  actors!: DemoActors;

  /** Mints a bearer token for an arbitrary subject/role set. */
  tokenFor(sub: string, roles: string[]): string {
    return mintToken(sub, roles);
  }

  /**
   * Seeds a fresh employee (reporting to the demo manager) with matching local
   * and HCM balances, so each scenario runs against an isolated row. Uses a
   * short-lived DB connection — safe alongside the running service under WAL.
   */
  async seedEmployee(id: string, days: number): Promise<Actor> {
    const ds = new DataSource(buildDataSourceOptions(this.dbFile));
    await ds.initialize();
    await ds.getRepository(Employee).insert({
      id,
      email: `${id}@example.com`,
      firstName: 'Demo',
      lastName: id,
      locationId: IDS.location,
      managerId: IDS.manager,
    });
    await ds.getRepository(Balance).insert({
      id: `bal_${id}`,
      employeeId: id,
      locationId: IDS.location,
      totalDays: days,
      reservedDays: 0,
      version: 0,
    });
    await ds.destroy();
    await this.control('balances', {
      employee_id: id,
      location_id: IDS.location,
      total_days: days,
    });
    return { sub: id, token: mintToken(id, ['EMPLOYEE']) };
  }

  static async start(opts: { initialBalanceDays: number; build?: boolean }): Promise<DemoHarness> {
    const h = new DemoHarness();
    await h.boot(opts);
    return h;
  }

  private async boot(opts: { initialBalanceDays: number; build?: boolean }): Promise<void> {
    this.tmpDir = mkdtempSync(join(tmpdir(), 'toff-demo-'));
    const dbFile = join(this.tmpDir, 'demo.sqlite');
    this.dbFile = dbFile;
    const svcPort = await freePort();
    const mockPort = await freePort();
    this.svcBase = `http://127.0.0.1:${svcPort}/api/v1`;
    this.mockBase = `http://127.0.0.1:${mockPort}`;

    const cleanup = (): void => this.stop();
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      this.stop();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      this.stop();
      process.exit(143);
    });

    if (opts.build !== false) {
      execFileSync('npx', ['nest', 'build', 'time-off-service'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
      execFileSync('npx', ['nest', 'build', 'mock-hcm'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    await this.migrateAndSeed(dbFile, opts.initialBalanceDays);

    const svcEnv = {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
      PORT: String(svcPort),
      DATABASE_FILE: dbFile,
      JWT_SIGNING_KEY: SIGNING_KEY,
      HCM_BASE_URL: this.mockBase,
      // Short windows so the resilience scenarios run in seconds, not minutes.
      HCM_BREAKER_COOLDOWN_MS: '1500',
      STUCK_STATE_THRESHOLD_MS: '1000',
      STUCK_STATE_SWEEP_INTERVAL_MS: '1000',
    };
    const mockEnv = { ...process.env, NODE_ENV: 'development', MOCK_HCM_PORT: String(mockPort) };

    this.mock = spawn('node', ['dist/apps/mock-hcm/main.js'], {
      cwd: REPO_ROOT,
      env: mockEnv,
      stdio: 'ignore',
    });
    this.service = spawn('node', ['dist/apps/time-off-service/main.js'], {
      cwd: REPO_ROOT,
      env: svcEnv,
      stdio: 'ignore',
    });

    await waitFor(`${this.mockBase}/mock/control/state`, 'mock-hcm');
    await waitFor(`${this.svcBase}/health`, 'time-off-service');

    // Seed the HCM side to match the local cache so the arithmetic check passes.
    await this.control('balances', {
      employee_id: IDS.employee,
      location_id: IDS.location,
      total_days: opts.initialBalanceDays,
    });

    this.actors = {
      employee: { sub: IDS.employee, token: mintToken(IDS.employee, ['EMPLOYEE']) },
      manager: { sub: IDS.manager, token: mintToken(IDS.manager, ['MANAGER']) },
      admin: { sub: IDS.admin, token: mintToken(IDS.admin, ['ADMIN']) },
    };
  }

  private async migrateAndSeed(dbFile: string, balanceDays: number): Promise<void> {
    const ds = new DataSource({
      ...buildDataSourceOptions(dbFile),
      migrations: [InitSchema1779625818136, AddRequestListIndexes1779660850392],
    });
    await ds.initialize();
    await ds.runMigrations();
    await ds.getRepository(Location).insert({ id: IDS.location, name: 'HQ', countryCode: 'US' });
    await ds.getRepository(Employee).insert({
      id: IDS.manager,
      email: 'manager@example.com',
      firstName: 'Mona',
      lastName: 'Manager',
      locationId: IDS.location,
      managerId: null,
    });
    await ds.getRepository(Employee).insert({
      id: IDS.employee,
      email: 'employee@example.com',
      firstName: 'Eddie',
      lastName: 'Employee',
      locationId: IDS.location,
      managerId: IDS.manager,
    });
    await ds.getRepository(Balance).insert({
      id: 'bal_demo',
      employeeId: IDS.employee,
      locationId: IDS.location,
      totalDays: balanceDays,
      reservedDays: 0,
      version: 0,
    });
    await ds.destroy();
  }

  /** Authenticated request against the time-off service. */
  async svc(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const res = await fetch(`${this.svcBase}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** Mock HCM control-plane call (mock/control/<action>). */
  async control(action: string, body: unknown): Promise<void> {
    await fetch(`${this.mockBase}/mock/control/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Recorded HCM-surface calls (oldest first). */
  async hcmCalls(): Promise<unknown[]> {
    const res = await fetch(`${this.mockBase}/mock/control/calls`);
    const json = (await res.json()) as { calls: unknown[] };
    return json.calls;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.service?.kill('SIGTERM');
    this.mock?.kill('SIGTERM');
    if (this.tmpDir) rmSync(this.tmpDir, { recursive: true, force: true });
  }
}
