import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A location scopes leave entitlements. An employee's primary location and
 * every balance row reference a Location (TRD §4.2).
 */
@Entity('locations')
export class Location {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  /** ISO 3166-1 alpha-2 country code. */
  @Column({ type: 'varchar', name: 'country_code' })
  countryCode!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
