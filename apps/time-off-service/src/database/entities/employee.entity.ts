import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * An employee who submits time-off requests and may manage direct reports.
 * `manager_id` is a nullable self-reference used for approval authorization
 * (TRD §4.2).
 */
@Entity('employees')
@Index('idx_employees_manager_id', ['managerId'])
export class Employee {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_employees_email', { unique: true })
  @Column({ type: 'varchar' })
  email!: string;

  @Column({ type: 'varchar', name: 'first_name' })
  firstName!: string;

  @Column({ type: 'varchar', name: 'last_name' })
  lastName!: string;

  @Column({ type: 'uuid', name: 'location_id' })
  locationId!: string;

  @Column({ type: 'uuid', name: 'manager_id', nullable: true })
  managerId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
