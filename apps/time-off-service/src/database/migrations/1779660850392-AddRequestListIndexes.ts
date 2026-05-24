import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestListIndexes1779660850392 implements MigrationInterface {
  name = 'AddRequestListIndexes1779660850392';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Supports keyset sort (submitted_at DESC, id DESC) used by GET /requests
    await queryRunner.query(
      `CREATE INDEX "idx_time_off_requests_submitted_at_id" ON "time_off_requests" ("submitted_at" DESC, "id" DESC)`,
    );
    // Supports status-filtered paginated list (status + sort columns)
    await queryRunner.query(
      `CREATE INDEX "idx_time_off_requests_status_submitted_at_id" ON "time_off_requests" ("status", "submitted_at" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_time_off_requests_status_submitted_at_id"`);
    await queryRunner.query(`DROP INDEX "idx_time_off_requests_submitted_at_id"`);
  }
}
