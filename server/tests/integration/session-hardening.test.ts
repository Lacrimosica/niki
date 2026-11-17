import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { sign, decode } from 'hono/jwt';
import app from '../../src/index';
import {
  initializeMiniflare,
  cleanupMiniflare,
  getMiniflareDB,
  getMiniflareRawDB,
} from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import { createTestOrganization, createTestUser, createTestOrganizationUser } from '../setup/fixtures';
import { hashPassword } from '../../src/lib/auth';
import { getPermissionsForRole } from '../../src/lib/session-permissions';
import * as schema from '../../src/db/schema';

const JWT_SECRET = 'test-jwt-secret-min-32-characters-long!!';
const API = 'http://localhost:8787';
const APP_URL = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const rolePermissions = (role: string) => JSON.stringify(getPermissionsForRole(role));

/** Session issuance, revocation and OAuth state binding. */
describe('Session hardening', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupMiniflare();
  });

  function env() {
    return {
      DB: getMiniflareRawDB(),
      JWT_SECRET,
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_BASE_URL: API,
      APP_URL,
    };
  }

  function request(path: string, init: RequestInit = {}) {
    return app.request(`${API}${path}`, init, env());
  }

  function authed(path: string, token: string, init: RequestInit = {}) {
    return request(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  async function seedUser(email = 'admin@org.local', googleId: string | null = null) {
    const org = await createTestOrganization({ slug: 'org' });
    const user = await createTestUser({ email, password: await hashPassword(PASSWORD), googleId });
    await createTestOrganizationUser(user.id, org.id, { role: 'core_admin', permissions: rolePermissions('core_admin') });
    return { org, user };
  }

  async function login(email: string) {
    const res = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  // GET /api/documents/drive-status only needs a valid session, so it probes auth alone.
  const probe = (token: string) => authed('/api/documents/drive-status', token);

  function fakeIdToken(claims: Record<string, unknown>) {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
  }

  function stubGoogleTokenEndpoint(body: Record<string, unknown>) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** Extract name=value of a Set-Cookie header, and the header itself. */
  function cookieFrom(res: Response, name: string) {
    const header = res.headers.get('set-cookie') ?? '';
    const match = header.match(new RegExp(`${name}=([^;]+)`));
    return { header, value: match?.[1] };
  }

  describe('session tokens', () => {
    it('issues typed, version-stamped tokens that expire within 8 hours', async () => {
      const { user } = await seedUser();
      const token = await login(user.email);
      const { payload } = decode(token);
      expect(payload.typ).toBe('session');
      expect(payload.tv).toBe(0);
      expect((payload.exp as number) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(8 * 3600);
    });

    it('rejects a correctly signed token without the session type', async () => {
      const { org, user } = await seedUser();
      const legacy = await sign(
        { sub: user.id, email: user.email, orgId: org.id, role: 'core_admin', permissions: [], exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET,
      );
      expect((await probe(legacy)).status).toBe(401);
    });

    it('rejects other token types signed with the same secret', async () => {
      const { org, user } = await seedUser();
      const drive = await sign(
        { type: 'drive_start', typ: 'drive', tv: 0, sub: user.id, orgId: org.id, exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET,
      );
      expect((await probe(drive)).status).toBe(401);
    });
  });

  describe('revocation', () => {
    it('logout revokes the token server-side', async () => {
      const { user } = await seedUser();
      const token = await login(user.email);
      expect((await probe(token)).status).toBe(200);

      const out = await authed('/api/auth/logout', token, { method: 'POST' });
      expect(out.status).toBe(204);
      expect((await probe(token)).status).toBe(401);

      // Logging in again works and yields a token for the new version.
      const fresh = await login(user.email);
      expect(decode(fresh).payload.tv).toBe(1);
      expect((await probe(fresh)).status).toBe(200);
    });

    it('logout with an already revoked token succeeds without bumping again', async () => {
      const { user } = await seedUser();
      const old = await login(user.email);
      await authed('/api/auth/logout', old, { method: 'POST' });
      const current = await login(user.email);

      expect((await authed('/api/auth/logout', old, { method: 'POST' })).status).toBe(204);
      expect((await probe(current)).status).toBe(200);
    });

    it('changing the password revokes old tokens and returns a working new one', async () => {
      const { user } = await seedUser();
      const token = await login(user.email);

      const res = await authed('/api/settings/change-password', token, {
        method: 'POST',
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'another-long-password' }),
      });
      expect(res.status).toBe(200);
      const { token: newToken } = (await res.json()) as { token: string };

      expect((await probe(token)).status).toBe(401);
      expect((await probe(newToken)).status).toBe(200);
    });

    it('an admin password reset revokes the target user\'s tokens', async () => {
      const { org, user: admin } = await seedUser();
      const target = await createTestUser({ email: 'member@org.local', password: await hashPassword(PASSWORD) });
      await createTestOrganizationUser(target.id, org.id, { role: 'viewer', permissions: rolePermissions('viewer'), isOwner: 0 });
      const adminToken = await login(admin.email);
      const targetToken = await login(target.email);
      expect((await probe(targetToken)).status).toBe(200);

      const res = await authed(`/api/settings/users/${target.id}/reset-password`, adminToken, {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'reset-by-admin-123' }),
      });
      expect(res.status).toBe(200);
      expect((await probe(targetToken)).status).toBe(401);
    });

    it('revoked tokens cannot create invites via /api/auth/invites', async () => {
      const { user } = await seedUser();
      const token = await login(user.email);
      await authed('/api/auth/logout', token, { method: 'POST' });

      const res = await authed('/api/auth/invites', token, {
        method: 'POST',
        body: JSON.stringify({ role: 'viewer' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Google login state binding', () => {
    it('sets an HttpOnly SameSite=Lax nonce cookie and embeds its hash in state', async () => {
      const res = await request('/api/auth/google');
      expect(res.status).toBe(302);
      const { header, value } = cookieFrom(res, 'oauth_nonce_login');
      expect(value).toBeTruthy();
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);

      const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
      expect(typeof decode(state).payload.nh).toBe('string');
    });

    it('marks the nonce cookie Secure on https', async () => {
      const res = await app.request('https://api.example.org/api/auth/google', {}, env());
      expect(cookieFrom(res, 'oauth_nonce_login').header).toMatch(/Secure/i);
    });

    it('rejects a callback from a browser that did not start the flow', async () => {
      const fetchMock = stubGoogleTokenEndpoint({});
      const start = await request('/api/auth/google');
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

      // Same valid state, but no cookie: e.g. an attacker's callback URL opened by a victim.
      const res = await request(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(302);
      const location = res.headers.get('location')!;
      expect(location).toContain('/auth/callback?error=');
      expect(location).not.toContain('token=');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a callback whose cookie belongs to a different flow start', async () => {
      stubGoogleTokenEndpoint({});
      const attackerStart = await request('/api/auth/google');
      const attackerState = new URL(attackerStart.headers.get('location')!).searchParams.get('state')!;
      const victimStart = await request('/api/auth/google');
      const victimNonce = cookieFrom(victimStart, 'oauth_nonce_login').value!;

      const res = await request(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(attackerState)}`, {
        headers: { Cookie: `oauth_nonce_login=${victimNonce}` },
      });
      expect(res.headers.get('location')).toContain('/auth/callback?error=');
    });

    it('delivers the session token in the URL fragment, never the query string', async () => {
      const { user } = await seedUser('g@org.local', 'google-sub-1');
      stubGoogleTokenEndpoint({ id_token: fakeIdToken({ sub: 'google-sub-1', email: user.email, email_verified: true }) });

      const start = await request('/api/auth/google');
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const nonce = cookieFrom(start, 'oauth_nonce_login').value!;

      const res = await request(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `oauth_nonce_login=${nonce}` },
      });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/auth/callback');
      expect(location.search).toBe('');
      const fragment = new URLSearchParams(location.hash.slice(1));
      const token = fragment.get('token')!;
      expect(decode(token).payload.typ).toBe('session');
      expect((await probe(token)).status).toBe(200);
    });

    it('delivers the set-password token in the URL fragment', async () => {
      const org = await createTestOrganization({ slug: 'org' });
      const user = await createTestUser({ email: 'nopw@org.local', password: null, googleId: 'google-sub-2' });
      await createTestOrganizationUser(user.id, org.id, { role: 'viewer', permissions: rolePermissions('viewer') });
      stubGoogleTokenEndpoint({ id_token: fakeIdToken({ sub: 'google-sub-2', email: user.email, email_verified: true }) });

      const start = await request('/api/auth/google');
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const nonce = cookieFrom(start, 'oauth_nonce_login').value!;

      const res = await request(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `oauth_nonce_login=${nonce}` },
      });
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/set-password');
      expect(location.search).toBe('');
      expect(new URLSearchParams(location.hash.slice(1)).get('token')).toBeTruthy();
    });
  });

  describe('Google Drive state binding', () => {
    async function startDrive(token: string) {
      const urlRes = await authed('/api/documents/drive-auth-url', token);
      expect(urlRes.status).toBe(200);
      const { url } = (await urlRes.json()) as { url: string };
      // Starts on the API origin so the binding cookie is first-party.
      expect(url.startsWith(`${API}/api/auth/google/drive/start?ticket=`)).toBe(true);

      const start = await app.request(url, {}, env());
      expect(start.status).toBe(302);
      const google = new URL(start.headers.get('location')!);
      expect(google.host).toBe('accounts.google.com');
      return {
        state: google.searchParams.get('state')!,
        nonce: cookieFrom(start, 'oauth_nonce_drive').value!,
      };
    }

    async function refreshTokenOf(userId: string) {
      const row = await getMiniflareDB().select().from(schema.user).where(eq(schema.user.id, userId)).get();
      return row?.googleRefreshToken ?? null;
    }

    it('stores the grant when the same browser and Google account complete the flow', async () => {
      const { user } = await seedUser('d@org.local', 'google-sub-d');
      const token = await login(user.email);
      const { state, nonce } = await startDrive(token);
      stubGoogleTokenEndpoint({
        refresh_token: 'rt', access_token: 'at', expires_in: 3600,
        id_token: fakeIdToken({ sub: 'google-sub-d', email: user.email, email_verified: true }),
      });

      const res = await request(`/api/auth/google/drive/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `oauth_nonce_drive=${nonce}` },
      });
      expect(res.headers.get('location')).toBe(`${APP_URL}/auth/drive-callback?success=1`);
      expect(await refreshTokenOf(user.id)).toBe('rt');
    });

    it('rejects a Drive callback without the binding cookie', async () => {
      const { user } = await seedUser('d@org.local', 'google-sub-d');
      const token = await login(user.email);
      const { state } = await startDrive(token);
      const fetchMock = stubGoogleTokenEndpoint({ refresh_token: 'rt', access_token: 'at', expires_in: 3600 });

      const res = await request(`/api/auth/google/drive/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(res.headers.get('location')).toContain('/auth/drive-callback?error=');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await refreshTokenOf(user.id)).toBeNull();
    });

    it('refuses to store a grant from a different Google account (victim lured through attacker link)', async () => {
      const { user: attacker } = await seedUser('attacker@org.local', 'google-sub-attacker');
      const token = await login(attacker.email);
      // The victim's browser follows the attacker's start link, so it holds a valid cookie.
      const { state, nonce } = await startDrive(token);
      stubGoogleTokenEndpoint({
        refresh_token: 'victim-rt', access_token: 'at', expires_in: 3600,
        id_token: fakeIdToken({ sub: 'google-sub-victim', email: 'victim@elsewhere.org', email_verified: true }),
      });

      const res = await request(`/api/auth/google/drive/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: `oauth_nonce_drive=${nonce}` },
      });
      expect(res.headers.get('location')).toContain('/auth/drive-callback?error=');
      expect(await refreshTokenOf(attacker.id)).toBeNull();
    });
  });
});
