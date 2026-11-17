import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import app from '../../src/index';
import { startGoogleLogin } from '../setup/http';
import {
  initializeMiniflare,
  cleanupMiniflare,
  getMiniflareDB,
  getMiniflareRawDB,
} from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import { createTestOrganization, createTestUser, createTestOrganizationUser } from '../setup/fixtures';
import * as schema from '../../src/db/schema';

const JWT_SECRET = 'test-jwt-secret-min-32-characters-long!!';

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build an unsigned ID token; the callback only decodes claims from Google's response. */
function fakeIdToken(claims: Record<string, unknown>): string {
  return `${base64Url('{"alg":"none"}')}.${base64Url(JSON.stringify(claims))}.sig`;
}

describe('Google login does not change membership role', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupMiniflare();
  });

  it('keeps a demoted owner as viewer with their stored permissions', async () => {
    const org = await createTestOrganization({ slug: 'org1', name: 'Org 1' });
    const user = await createTestUser({ email: 'owner@org1.local', googleId: 'google-sub-1' });
    const membership = await createTestOrganizationUser(user.id, org.id, { role: 'core_admin' });
    const db = getMiniflareDB();

    // A deliberate demotion by another admin.
    await db.update(schema.organizationUser)
      .set({ isOwner: 1, role: 'viewer', permissions: JSON.stringify(['dashboard.view']) })
      .where(eq(schema.organizationUser.id, membership.id))
      .run();

    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({
          id_token: fakeIdToken({ sub: 'google-sub-1', email: 'owner@org1.local', email_verified: true }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ));

    const googleEnv = {
      DB: getMiniflareRawDB(),
      JWT_SECRET,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REDIRECT_BASE_URL: 'http://localhost:8787',
      APP_URL: 'http://localhost:5173',
    };
    const { state, cookie } = await startGoogleLogin(googleEnv);
    const res = await app.request(
      `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: cookie } },
      googleEnv,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('token=');
    expect(location).not.toContain('error=');

    const row = await db.select().from(schema.organizationUser)
      .where(eq(schema.organizationUser.id, membership.id))
      .get();
    expect(row?.role).toBe('viewer');
    expect(JSON.parse(row?.permissions ?? '[]')).toEqual(['dashboard.view']);

    const user_ = new URLSearchParams(new URL(location).hash.slice(1)).get('user');
    expect(JSON.parse(user_ ?? '{}').role).toBe('viewer');
  });
});
