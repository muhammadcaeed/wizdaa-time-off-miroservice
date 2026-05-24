import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type ReconciliationStatus = 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_CONFLICTS' | 'FAILED';
export type ReconciliationTrigger = 'SCHEDULED' | 'ON_DEMAND' | 'POINT';

/**
 * A tracked reconciliation run (TRD §4.2, §9.3). The partial UNIQUE index
 * enforces at most one RUNNING run at a time (REQ-REC-06).
 */
@Entity('reconciliations')
@Index('uq_reconciliations_single_running', ['status'], {
  unique: true,
  where: "status = 'RUNNING'",
})
export class Reconciliation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  status!: ReconciliationStatus;

  /** Inclusive lower bound used for the HCM batch query. */
  @Column({ type: 'datetime' })
  since!: Date;

  @Column({ type: 'datetime', name: 'started_at' })
  startedAt!: Date;

  @Column({ type: 'datetime', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'integer', name: 'balances_examined', default: 0 })
  balancesExamined!: number;

  @Column({ type: 'integer', default: 0 })
  conflicts!: number;

  @Column({ type: 'varchar', name: 'trigger_type' })
  triggerType!: ReconciliationTrigger;
}
