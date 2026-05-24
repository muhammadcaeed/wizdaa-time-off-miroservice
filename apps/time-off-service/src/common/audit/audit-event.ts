import type { ActorType, AuditEntityType } from '../../database/entities';

/**
 * A single audit fact: who did what to which entity, with optional before/after
 * snapshots and saga correlation. `timestamp` is stamped by the service.
 */
export interface AuditEvent {
  actorId?: string | null;
  actorType: ActorType;
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  beforeState?: unknown;
  afterState?: unknown;
  correlationId?: string | null;
  metadata?: unknown;
}
