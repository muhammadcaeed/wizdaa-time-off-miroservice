import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Mirror of an employee's leave balance for one location. `total_days` is
 * sourced from the HCM; `reserved_days` is maintained transactionally by the
 * reservation pattern (ADR-001). `version` drives optimistic concurrency
 * control via a manual `WHERE version = :expected` predicate (ADR-005); it is
 * deliberately a plain column, not a TypeORM @VersionColumn, so the saga
 * controls increments explicitly. See TRD §4.2, §10.
 */
@Entity('balances')
@Unique('uq_balances_employee_location', ['employeeId', 'locationId'])
@Index('idx_balances_employee_id', ['employeeId'])
export class Balance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'uuid', name: 'location_id' })
  locationId!: string;

  @Column({ type: 'integer', name: 'total_days' })
  totalDays!: number;

  @Column({ type: 'integer', name: 'reserved_days', default: 0 })
  reservedDays!: number;

  @Column({ type: 'integer', default: 0 })
  version!: number;

  @Column({ type: 'datetime', name: 'last_hcm_sync_at', nullable: true })
  lastHcmSyncAt!: Date | null;

  @Column({
    type: 'varchar',
    name: 'last_hcm_correlation_id',
    nullable: true,
  })
  lastHcmCorrelationId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
