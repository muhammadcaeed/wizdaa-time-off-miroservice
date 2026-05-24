import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThan } from 'typeorm';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';

/** Subset of stored idempotency state needed for replay decisions. */
export interface IdempotencyCheck {
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
}

/**
 * Manages client-facing idempotency records (api-contract.md §6, TRD §4.2).
 *
 * - {@link check} looks up a non-expired record for the given key.
 * - {@link record} inserts a new record inside the caller's EntityManager
 *   transaction — the single-transaction invariant: the operation outcome and
 *   its idempotency record share one DB commit boundary.
 * - {@link cleanup} deletes expired records (called by the hourly cron).
 */
@Injectable()
export class IdempotencyService {
  private readonly ttlHours: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.ttlHours = this.config.get<number>('IDEMPOTENCY_TTL_HOURS', 24);
  }

  /**
   * Returns the stored record for the given key if it exists and has not expired;
   * returns null for unknown keys or expired records.
   * @param key the client-supplied `Idempotency-Key` UUID
   */
  async check(key: string): Promise<IdempotencyCheck | null> {
    const repo = this.dataSource.getRepository(IdempotencyRecord);
    const record = await repo.findOneBy({ key });
    if (!record) {
      return null;
    }
    if (record.expiresAt <= new Date()) {
      // Expired — treat as unseen so the operation re-executes.
      return null;
    }
    return {
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseBody: record.responseBody,
    };
  }

  /**
   * Inserts a new idempotency record inside the given EntityManager's transaction.
   * Must be called AFTER the operation succeeds so the record and operation outcome
   * share the same commit. If `key` is undefined (no header supplied), this is a
   * no-op.
   * @param key the client-supplied UUID, or undefined when no header was sent
   * @param hash the SHA-256 request fingerprint
   * @param status the HTTP response status that was returned to the client
   * @param body the serialised response body
   * @param manager the active EntityManager (same transaction as the operation)
   */
  async record(
    key: string | undefined,
    hash: string,
    status: number,
    body: unknown,
    manager: EntityManager,
  ): Promise<void> {
    if (!key) {
      return;
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlHours * 60 * 60 * 1000);
    // TypeORM's insert type doesn't accept `unknown` for simple-json columns;
    // cast to `Record<string, unknown>` which is the narrowest safe type for
    // a JSON object. The entity column type handles serialization.
    await manager.getRepository(IdempotencyRecord).insert({
      key,
      requestHash: hash,
      responseStatus: status,
      responseBody: body as Record<string, unknown>,
      createdAt: now,
      expiresAt,
    });
  }

  /**
   * Deletes all expired idempotency records. Called by the hourly cleanup cron.
   */
  async cleanup(): Promise<void> {
    await this.dataSource
      .getRepository(IdempotencyRecord)
      .delete({ expiresAt: LessThan(new Date()) });
  }
}
