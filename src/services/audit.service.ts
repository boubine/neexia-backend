import { prisma } from '../config/prisma';

interface AuditOptions {
  entityType: string;
  entityId: string;
  eventType: string;
  userId?: string;
  payload: Record<string, unknown>;
}

/**
 * Écrit une entrée immuable dans l'audit log.
 * Appelé après chaque opération critique (shift, paiement, application).
 */
export async function audit(options: AuditOptions) {
  await prisma.auditLog.create({
    data: {
      entityType: options.entityType,
      entityId:   options.entityId,
      eventType:  options.eventType,
      userId:     options.userId,
      payload:    options.payload,
    },
  });
}
