import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type { ActorType, AuditEntityType } from '../../database/entities';
import { AuditLog } from '../../database/entities';

/** A fully-formed audit row to append — never carries an `id` (the DB generates it). */
export interface NewAuditRow {
  timestamp: Date;
  actorId: string | null;
  actorType: ActorType;
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  beforeState: unknown;
  afterState: unknown;
  correlationId: string | null;
  metadata: unknown;
}

/**
 * Append-only data access for {@link AuditLog}. Exposes `insert` and nothing
 * else — no update, no delete. This is the application-layer enforcement of
 * INV-05 / REQ-DEF-06. The insert takes the caller's {@link EntityManager} so
 * the audit row commits atomically with the state change it describes (§10.4).
 */
@Injectable()
export class AuditRepository {
  async insert(row: NewAuditRow, manager: EntityManager): Promise<void> {
    // A true INSERT (not `save`): adds a row and errors on PK collision — it can
    // never UPDATE an existing audit row. With the `id`-less {@link NewAuditRow}
    // an accidental update is unrepresentable. The cast bridges the entity's
    // `unknown`-typed JSON columns, which `QueryDeepPartialEntity` can't express.
    await manager.getRepository(AuditLog).insert(row as QueryDeepPartialEntity<AuditLog>);
  }
}
