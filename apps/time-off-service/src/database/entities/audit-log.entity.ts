import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ActorType = 'EMPLOYEE' | 'MANAGER' | 'ADMIN' | 'SYSTEM';
export type AuditEntityType = 'REQUEST' | 'BALANCE' | 'HCM_CALL';

/**
 * Append-only record of every state change and HCM interaction (TRD §4.2,
 * INV-05). The append-only property is enforced at the application layer: the
 * audit repository exposes only inserts. No row is ever updated or deleted.
 */
@Entity('audit_logs')
@Index('idx_audit_logs_entity', ['entityType', 'entityId'])
@Index('idx_audit_logs_correlation_id', ['correlationId'])
@Index('idx_audit_logs_timestamp', ['timestamp'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'datetime' })
  timestamp!: Date;

  @Column({ type: 'uuid', name: 'actor_id', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', name: 'actor_type' })
  actorType!: ActorType;

  @Column({ type: 'varchar', name: 'entity_type' })
  entityType!: AuditEntityType;

  /** Reference to the entity; not enforced as an FK. */
  @Column({ type: 'varchar', name: 'entity_id' })
  entityId!: string;

  /** Dotted action notation, e.g. `request.approved`. */
  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'simple-json', name: 'before_state', nullable: true })
  beforeState!: unknown;

  @Column({ type: 'simple-json', name: 'after_state', nullable: true })
  afterState!: unknown;

  @Column({ type: 'varchar', name: 'correlation_id', nullable: true })
  correlationId!: string | null;

  @Column({ type: 'simple-json', nullable: true })
  metadata!: unknown;
}
