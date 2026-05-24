import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1779625818136 implements MigrationInterface {
  name = 'InitSchema1779625818136';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "employees" ("id" varchar PRIMARY KEY NOT NULL, "email" varchar NOT NULL, "first_name" varchar NOT NULL, "last_name" varchar NOT NULL, "location_id" varchar NOT NULL, "manager_id" varchar, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "idx_employees_email" ON "employees" ("email") `);
    await queryRunner.query(
      `CREATE INDEX "idx_employees_manager_id" ON "employees" ("manager_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "locations" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL, "country_code" varchar NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE TABLE "balances" ("id" varchar PRIMARY KEY NOT NULL, "employee_id" varchar NOT NULL, "location_id" varchar NOT NULL, "total_days" integer NOT NULL, "reserved_days" integer NOT NULL DEFAULT (0), "version" integer NOT NULL DEFAULT (0), "last_hcm_sync_at" datetime, "last_hcm_correlation_id" varchar, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "uq_balances_employee_location" UNIQUE ("employee_id", "location_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_balances_employee_id" ON "balances" ("employee_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "time_off_requests" ("id" varchar PRIMARY KEY NOT NULL, "employee_id" varchar NOT NULL, "location_id" varchar NOT NULL, "start_date" date NOT NULL, "end_date" date NOT NULL, "days_requested" integer NOT NULL, "status" varchar NOT NULL, "submitted_at" datetime NOT NULL, "decided_at" datetime, "decided_by" varchar, "hcm_correlation_id" varchar, "failure_reason" varchar, "reason" varchar, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_time_off_requests_start_date" ON "time_off_requests" ("start_date") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_time_off_requests_status" ON "time_off_requests" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_time_off_requests_employee_status" ON "time_off_requests" ("employee_id", "status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" varchar PRIMARY KEY NOT NULL, "timestamp" datetime NOT NULL, "actor_id" varchar, "actor_type" varchar NOT NULL, "entity_type" varchar NOT NULL, "entity_id" varchar NOT NULL, "action" varchar NOT NULL, "before_state" text, "after_state" text, "correlation_id" varchar, "metadata" text)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_timestamp" ON "audit_logs" ("timestamp") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_correlation_id" ON "audit_logs" ("correlation_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_entity" ON "audit_logs" ("entity_type", "entity_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "idempotency_records" ("key" varchar PRIMARY KEY NOT NULL, "request_hash" varchar NOT NULL, "response_body" text NOT NULL, "response_status" integer NOT NULL, "created_at" datetime NOT NULL, "expires_at" datetime NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_idempotency_records_expires_at" ON "idempotency_records" ("expires_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "reconciliations" ("id" varchar PRIMARY KEY NOT NULL, "status" varchar NOT NULL, "since" datetime NOT NULL, "started_at" datetime NOT NULL, "completed_at" datetime, "balances_examined" integer NOT NULL DEFAULT (0), "conflicts" integer NOT NULL DEFAULT (0), "trigger_type" varchar NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_reconciliations_single_running" ON "reconciliations" ("status") WHERE status = 'RUNNING'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_reconciliations_single_running"`);
    await queryRunner.query(`DROP TABLE "reconciliations"`);
    await queryRunner.query(`DROP INDEX "idx_idempotency_records_expires_at"`);
    await queryRunner.query(`DROP TABLE "idempotency_records"`);
    await queryRunner.query(`DROP INDEX "idx_audit_logs_entity"`);
    await queryRunner.query(`DROP INDEX "idx_audit_logs_correlation_id"`);
    await queryRunner.query(`DROP INDEX "idx_audit_logs_timestamp"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP INDEX "idx_time_off_requests_employee_status"`);
    await queryRunner.query(`DROP INDEX "idx_time_off_requests_status"`);
    await queryRunner.query(`DROP INDEX "idx_time_off_requests_start_date"`);
    await queryRunner.query(`DROP TABLE "time_off_requests"`);
    await queryRunner.query(`DROP INDEX "idx_balances_employee_id"`);
    await queryRunner.query(`DROP TABLE "balances"`);
    await queryRunner.query(`DROP TABLE "locations"`);
    await queryRunner.query(`DROP INDEX "idx_employees_manager_id"`);
    await queryRunner.query(`DROP INDEX "idx_employees_email"`);
    await queryRunner.query(`DROP TABLE "employees"`);
  }
}
