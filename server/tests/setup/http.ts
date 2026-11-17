import { and, eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import app from '../../src/index';
import { getMiniflareDB, getMiniflareRawDB } from './miniflare-context';
import * as schema from '../../src/db/schema';

export const TEST_JWT_SECRET = 'test-jwt-secret-min-32-characters-long!!';

type DeploymentMode = 'single_org' | 'open' | 'invite_only' | 'closed';

export function testEnv(deploymentMode: DeploymentMode = 'open') {
  return { DB: getMiniflareRawDB(), JWT_SECRET: TEST_JWT_SECRET, DEPLOYMENT_MODE: deploymentMode };
}

/**
 * Issue a session token for an existing membership. The session middleware
 * reloads role/permissions from organization_user on every request, so pass
 * `syncMembership` to store the same values there; otherwise the membership's
 * current DB values win over whatever the token claims.
 */
export async function mintSessionToken(
  userId: string,
  orgId: string,
  permissions: string[],
  role = 'core_admin',
  { syncMembership = true }: { syncMembership?: boolean } = {},
) {
  if (syncMembership) {
    await getMiniflareDB()
      .update(schema.organizationUser)
      .set({ role, permissions: JSON.stringify(permissions) })
      .where(and(eq(schema.organizationUser.userId, userId), eq(schema.organizationUser.orgId, orgId)))
      .run();
  }
  return sign(
    {
      sub: userId,
      email: `${userId}@test.local`,
      orgId,
      role,
      permissions,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    TEST_JWT_SECRET,
  );
}

/** Mint a short-lived setup_session token, as GET /api/setup/token would. */
export function mintSetupToken() {
  const now = Math.floor(Date.now() / 1000);
  return sign({ type: 'setup_session', iat: now, exp: now + 30 * 60 }, TEST_JWT_SECRET);
}

export async function callApi(
  method: string,
  path: string,
  { token, body, mode = 'open' }: { token?: string; body?: unknown; mode?: DeploymentMode } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    testEnv(mode),
  );
}
