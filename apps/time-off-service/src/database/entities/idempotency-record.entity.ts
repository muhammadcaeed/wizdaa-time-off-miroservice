import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Persistent store for client-facing idempotency (the `Idempotency-Key`
 * header). A periodic job removes rows past `expires_at`. Semantics in
 * api-contract.md §6. See TRD §4.2.
 */
@Entity('idempotency_records')
export class IdempotencyRecord {
  /** The client-supplied `Idempotency-Key`. */
  @PrimaryColumn({ type: 'varchar' })
  key!: string;

  /** SHA-256 of the canonicalized request body. */
  @Column({ type: 'varchar', name: 'request_hash' })
  requestHash!: string;

  @Column({ type: 'simple-json', name: 'response_body' })
  responseBody!: unknown;

  @Column({ type: 'integer', name: 'response_status' })
  responseStatus!: number;

  @Column({ type: 'datetime', name: 'created_at' })
  createdAt!: Date;

  @Index('idx_idempotency_records_expires_at')
  @Column({ type: 'datetime', name: 'expires_at' })
  expiresAt!: Date;
}
