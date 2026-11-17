import { sign, verify } from 'hono/jwt';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import { organizationUser, user } from '../db/schema';
import { sessionPermissions } from './session-permissions';

/**
 * Session lifetime. Kept to a working day: tokens live in localStorage, so a
 * shorter window limits how long a copied token is useful if revocation is missed.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 8;

/** Distinguishes session tokens from the other JWTs signed with the same secret. */
export const SESSION_TOKEN_TYPE = 'session';

export type SessionClaims = {
  sub: string;
  email: string;
  orgId: string;
  role: string;
  permissions: string[];
};

export type SessionPayload = SessionClaims & {
  typ: typeof SESSION_TOKEN_TYPE;
  /** user.token_version at issue time; bumping the column revokes the token. */
  tv: number;
  exp: number;
};

export async function issueSessionToken(
  secret: string,
  claims: SessionClaims,
  tokenVersion: number,
): Promise<string> {
  const payload: SessionPayload = {
    ...claims,
    typ: SESSION_TOKEN_TYPE,
    tv: tokenVersion,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  return sign(payload, secret);
}

/**
 * Structural check on an already signature-verified payload. Tokens issued before
 * `typ`/`tv` existed are rejected on purpose: they carry no revocation counter, and
 * the one-time logout on deploy is cheaper than keeping a non-revocable path.
 */
export function isSessionPayload(payload: unknown): payload is SessionPayload {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    p.typ === SESSION_TOKEN_TYPE &&
    typeof p.tv === 'number' &&
    typeof p.sub === 'string' &&
    typeof p.orgId === 'string'
  );
}

/** Verify signature, expiry and token type of a raw bearer token. */
export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const payload = await verify(token, secret, 'HS256');
    return isSessionPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Load the current membership for a session and check the token has not been
 * revoked. Returns the payload refreshed with the DB role/permissions, or null.
 */
export async function loadSession(db: D1Database, payload: SessionPayload): Promise<SessionPayload | null> {
  const row = await drizzle(db)
    .select({
      role: organizationUser.role,
      permissions: organizationUser.permissions,
      tokenVersion: user.tokenVersion,
    })
    .from(organizationUser)
    .innerJoin(user, eq(user.id, organizationUser.userId))
    .where(and(eq(organizationUser.userId, payload.sub), eq(organizationUser.orgId, payload.orgId)))
    .get();

  if (!row || row.tokenVersion !== payload.tv) return null;

  // Role and permissions can change after the token was issued (e.g. a demotion);
  // handlers must see the current values, not the ones frozen into the JWT.
  return { ...payload, role: row.role, permissions: sessionPermissions(row) };
}

/** Full check for routes outside the global session middleware (e.g. /api/auth/*). */
export async function authenticateBearer(
  authHeader: string | undefined,
  db: D1Database,
  secret: string,
): Promise<SessionPayload | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const payload = await verifySessionToken(authHeader.slice(7), secret);
  return payload ? loadSession(db, payload) : null;
}
