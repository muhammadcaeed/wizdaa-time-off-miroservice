import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { AuditEvent } from './audit-event';
import { AuditRepository } from './audit.repository';

/**
 * Writes audit facts. Every state change (REQ-DEF-05) and HCM interaction
 * (REQ-SYNC-05) calls {@link record} with the active transaction manager, so the
 * audit row shares the state change's commit boundary — a state change without
 * its audit entry is impossible (INV-05, TRD §10.4).
 */
@Injectable()
export class AuditService {
  constructor(private readonly auditRepository: AuditRepository) {}

  /**
   * Appends one audit row inside the caller's transaction.
   * @param event the audit fact (actor, action, before/after, correlation)
   * @param manager the active transaction manager to enlist the insert in
   */
  async record(event: AuditEvent, manager: EntityManager): Promise<void> {
    await this.auditRepository.insert(
      {
        timestamp: new Date(),
        actorId: event.actorId ?? null,
        actorType: event.actorType,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        beforeState: event.beforeState ?? null,
        afterState: event.afterState ?? null,
        correlationId: event.correlationId ?? null,
        metadata: event.metadata ?? null,
      },
      manager,
    );
  }
}
