import type { Context } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { auditEvent } from '../db/schema';

export type AuditEventInput = {
  eventType: string;
  actorId: string | null;
  orgId: string | null;
  payload?: Record<string, unknown>;
};

/** Best-effort client IP, matching what setup.ts records. */
export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
}

/**
 * Append a row to audit_event.
 *
 * Failures are logged rather than thrown so that a broken audit write never turns
 * an operation that already happened into an error response.
 */
export async function recordAuditEvent(db: D1Database, ip: string, event: AuditEventInput): Promise<void> {
  try {
    await drizzle(db).insert(auditEvent).values({
      id: crypto.randomUUID(),
      eventType: event.eventType,
      actorId: event.actorId,
      orgId: event.orgId,
      payload: event.payload ? JSON.stringify(event.payload) : null,
      ip,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`Failed to record audit event ${event.eventType}:`, err);
  }
}
