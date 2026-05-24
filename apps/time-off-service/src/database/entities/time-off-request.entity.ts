import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The eight lifecycle states of a time-off request (TRD §5). Stored as a
 * string column for SQLite/Postgres portability.
 */
export type RequestStatus =
  | 'SUBMITTED'
  | 'APPROVING'
  | 'APPROVED'
  | 'APPROVAL_FAILED'
  | 'REJECTED'
  | 'CANCELLING'
  | 'CANCELLATION_FAILED'
  | 'CANCELLED';

/**
 * A time-off request and its lifecycle state. Drives the forward (approval)
 * and reverse (cancellation) sagas. `hcm_correlation_id` ties saga steps to
 * the HCM operation that crossed the boundary (INV-04). See TRD §4.2, §5.
 */
@Entity('time_off_requests')
@Index('idx_time_off_requests_employee_status', ['employeeId', 'status'])
@Index('idx_time_off_requests_status', ['status'])
@Index('idx_time_off_requests_start_date', ['startDate'])
@Index('idx_time_off_requests_submitted_at_id', ['submittedAt', 'id'])
@Index('idx_time_off_requests_status_submitted_at_id', ['status', 'submittedAt', 'id'])
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'uuid', name: 'location_id' })
  locationId!: string;

  @Column({ type: 'date', name: 'start_date' })
  startDate!: string;

  @Column({ type: 'date', name: 'end_date' })
  endDate!: string;

  @Column({ type: 'integer', name: 'days_requested' })
  daysRequested!: number;

  @Column({ type: 'varchar' })
  status!: RequestStatus;

  @Column({ type: 'datetime', name: 'submitted_at' })
  submittedAt!: Date;

  @Column({ type: 'datetime', name: 'decided_at', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'uuid', name: 'decided_by', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'varchar', name: 'hcm_correlation_id', nullable: true })
  hcmCorrelationId!: string | null;

  @Column({ type: 'varchar', name: 'failure_reason', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'varchar', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
