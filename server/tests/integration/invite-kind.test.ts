import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import app from '../../src/index';
import {
  initializeMiniflare,
  cleanupMiniflare,
  getMiniflareDB,
  getMiniflareRawDB,
} from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import {
  createTestOrganization,
  createTestUser,
  createTestOrganizationUser,
  createTestInvite,
  countOrganizations,
} from '../setup/fixtures';
import * as schema from '../../src/db/schema';

const JWT_SECRET = 'test-jwt-secret-min-32-characters-long!!';

/**
 * Org-creation invites vs member invites, and single-use redemption of both.
 * Routes are driven in-process; Google's token endpoint is stubbed.
 */
describe('Invite kinds and atomic redemption', () => {
  beforeEach(async () => {
    await initializeMiniflare('invite_only');
    await resetTestDatabase();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupMiniflare();
  });

  function env(extra: Record<string, string> = {}) {
    return {
      ...extra,
      DB: getMiniflareRawDB(),
      JWT_SECRET,
      DEPLOYMENT_MODE: 'invite_only',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_BASE_URL: 'http://localhost:8787',
      APP_URL: 'http://app.test',
    };
  }

  /** Session token whose role/permissions also live on the membership row (the middleware reloads them). */
  async function mintToken(userId: string, orgId: string, role: string) {
    await getMiniflareDB().update(schema.organizationUser)
      .set({ role, permissions: '[]' })
      .where(and(eq(schema.organizationUser.userId, userId), eq(schema.organizationUser.orgId, orgId)))
      .run();
    return sign(
      { sub: userId, email: `${userId}@test.local`, orgId, role, permissions: [], exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
  }

  async function seedOrgWithAdmin(role = 'core_admin') {
    const org = await createTestOrganization({ slug: `org-${crypto.randomUUID()}` });
    const admin = await createTestUser({ email: `admin-${crypto.randomUUID()}@org.local` });
    await createTestOrganizationUser(admin.id, org.id, { role });
    return { org, admin };
  }

  async function postSetup(orgCreationToken: string, suffix: string, adminEmail = `new-${suffix}@neworg.local`) {
    const setupToken = await sign(
      { type: 'setup_session', exp: Math.floor(Date.now() / 1000) + 600 },
      JWT_SECRET,
    );
    return app.request(
      '/api/setup',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${setupToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgName: `New Org ${suffix}`,
          shortName: `NO${suffix}`,
          slug: `new-org-${suffix}`,
          adminEmail,
          adminPassword: 'a-long-password',
          orgCreationToken,
        }),
      },
      env(),
    );
  }

  /** Stub Google's token exchange so each OAuth code maps to a fixed verified identity. */
  function stubGoogle(identities: Record<string, { email: string; sub: string }>) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://oauth2.googleapis.com/token')) return realFetch(input, init);
      const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
      const claims = { ...identities[code], email_verified: true };
      const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return new Response(JSON.stringify({ id_token: `h.${payload}.s` }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  async function googleCallback(code: string, inviteToken: string) {
    const state = await sign({ type: 'login', inviteToken, exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);
    const res = await app.request(
      `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      {},
      env(),
    );
    return res.headers.get('Location') ?? '';
  }

  async function membershipsIn(orgId: string) {
    return getMiniflareDB().select().from(schema.organizationUser)
      .where(eq(schema.organizationUser.orgId, orgId)).all();
  }

  describe('org creation in invite_only mode', () => {
    it('rejects a member invite as an org-creation token', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const memberInvite = await createTestInvite(org.id, admin.id, { email: null });

      const res = await postSetup(memberInvite.token, 'a');

      expect(res.status).toBe(403);
      expect(await countOrganizations()).toBe(1);
      const row = await getMiniflareDB().select().from(schema.invite)
        .where(eq(schema.invite.id, memberInvite.id)).get();
      expect(row?.usedAt).toBeNull();
    });

    it('accepts an org-creation invite once and rejects a second use', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const orgInvite = await createTestInvite(org.id, admin.id, { email: null, kind: 'org_creation', role: 'core_admin' });

      const first = await postSetup(orgInvite.token, 'b');
      expect(first.status).toBe(200);
      const { user: created } = (await first.json()) as { user: { id: string } };

      const row = await getMiniflareDB().select().from(schema.invite)
        .where(eq(schema.invite.id, orgInvite.id)).get();
      expect(row?.usedAt).toBeTruthy();
      expect(row?.usedByUserId).toBe(created.id);

      const second = await postSetup(orgInvite.token, 'c');
      expect(second.status).toBe(403);
      expect(await countOrganizations()).toBe(2);
    });

    it('lets only one of two concurrent setups redeem the same org-creation invite', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const orgInvite = await createTestInvite(org.id, admin.id, { email: null, kind: 'org_creation', role: 'core_admin' });

      const results = await Promise.all([postSetup(orgInvite.token, 'd'), postSetup(orgInvite.token, 'e')]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
      expect(await countOrganizations()).toBe(2);
    });
  });

  describe('issuing org-creation invites', () => {
    async function issue(token: string, body: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
      return app.request(
        '/api/auth/invites',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env(extraEnv),
      );
    }

    async function inviteCount() {
      return (await getMiniflareDB().select().from(schema.invite).all()).length;
    }

    it('lets a listed platform admin issue one (case-insensitive), usable for setup', async () => {
      const { org, admin } = await seedOrgWithAdmin('viewer');
      const token = await mintToken(admin.id, org.id, 'viewer');
      const list = ` someone@else.local , ${admin.email.toUpperCase()} `;

      const res = await issue(token, { kind: 'org_creation' }, { PLATFORM_ADMIN_EMAILS: list });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; kind: string; role: string; url: string | null };
      expect(body.kind).toBe('org_creation');
      expect(body.role).toBe('core_admin');
      expect(body.url).toBeNull();

      expect((await postSetup(body.token, 'f')).status).toBe(200);
    });

    it('refuses a core_admin who is not listed', async () => {
      const { org, admin } = await seedOrgWithAdmin('core_admin');
      const token = await mintToken(admin.id, org.id, 'core_admin');

      const res = await issue(token, { kind: 'org_creation' }, { PLATFORM_ADMIN_EMAILS: 'platform@ops.local' });

      expect(res.status).toBe(403);
      expect(await inviteCount()).toBe(0);
    });

    it('uses the email from the user row, not the JWT', async () => {
      const { org, admin } = await seedOrgWithAdmin('core_admin');
      await mintToken(admin.id, org.id, 'core_admin');
      const forged = await sign(
        { sub: admin.id, email: 'platform@ops.local', orgId: org.id, role: 'core_admin', permissions: [], exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET,
      );

      const res = await issue(forged, { kind: 'org_creation' }, { PLATFORM_ADMIN_EMAILS: 'platform@ops.local' });

      expect(res.status).toBe(403);
      expect(await inviteCount()).toBe(0);
    });

    it('refuses everyone when PLATFORM_ADMIN_EMAILS is unset or empty', async () => {
      const { org, admin } = await seedOrgWithAdmin('core_admin');
      const token = await mintToken(admin.id, org.id, 'core_admin');

      expect((await issue(token, { kind: 'org_creation' })).status).toBe(403);
      expect((await issue(token, { kind: 'org_creation' }, { PLATFORM_ADMIN_EMAILS: ' , ' })).status).toBe(403);
      expect(await inviteCount()).toBe(0);
    });

    it('still issues member invites by default', async () => {
      const { org, admin } = await seedOrgWithAdmin('admin');
      const token = await mintToken(admin.id, org.id, 'admin');

      const res = await issue(token, { role: 'viewer' });
      expect(res.status).toBe(200);
      const row = await getMiniflareDB().select().from(schema.invite).get();
      expect(row?.kind).toBe('member');
    });
  });

  describe('member invite redemption', () => {
    it('lets only one of two concurrent redemptions of an untargeted invite succeed', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const memberInvite = await createTestInvite(org.id, admin.id, { email: null, role: 'viewer' });
      stubGoogle({
        one: { email: 'one@guest.local', sub: 'g-one' },
        two: { email: 'two@guest.local', sub: 'g-two' },
      });

      const locations = await Promise.all([googleCallback('one', memberInvite.token), googleCallback('two', memberInvite.token)]);

      expect(locations.filter((l) => l.includes('error=')).length).toBe(1);
      // The admin plus exactly one redeemer.
      expect(await membershipsIn(org.id)).toHaveLength(2);
    });

    it('rejects a sequential second redemption', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const memberInvite = await createTestInvite(org.id, admin.id, { email: null, role: 'viewer' });
      stubGoogle({
        one: { email: 'one@guest.local', sub: 'g-one' },
        two: { email: 'two@guest.local', sub: 'g-two' },
      });

      expect(await googleCallback('one', memberInvite.token)).not.toContain('error=');
      expect(await googleCallback('two', memberInvite.token)).toContain('error=');
      expect(await membershipsIn(org.id)).toHaveLength(2);
    });

    it('matches the invite email case-insensitively', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const memberInvite = await createTestInvite(org.id, admin.id, { email: 'Mixed.Case@Guest.local', role: 'viewer' });
      stubGoogle({ mixed: { email: 'mixed.case@guest.local', sub: 'g-mixed' } });

      expect(await googleCallback('mixed', memberInvite.token)).not.toContain('error=');
      const members = await membershipsIn(org.id);
      expect(members).toHaveLength(2);
    });

    it('does not redeem an org-creation invite as a membership', async () => {
      const { org, admin } = await seedOrgWithAdmin();
      const orgInvite = await createTestInvite(org.id, admin.id, { email: null, kind: 'org_creation', role: 'core_admin' });
      stubGoogle({ one: { email: 'one@guest.local', sub: 'g-one' } });

      expect(await googleCallback('one', orgInvite.token)).toContain('error=');
      expect(await membershipsIn(org.id)).toHaveLength(1);
    });

    it('checks membership in the invite org, not the first membership found', async () => {
      const { org: orgA } = await seedOrgWithAdmin();
      const { org: orgB, admin: adminB } = await seedOrgWithAdmin();
      // Already a member of both orgs; orgA's row comes first.
      const guest = await createTestUser({ email: 'guest@multi.local', googleId: 'g-guest' });
      await createTestOrganizationUser(guest.id, orgA.id, { role: 'viewer', isOwner: 0 });
      await createTestOrganizationUser(guest.id, orgB.id, { role: 'viewer', isOwner: 0 });
      const inviteToB = await createTestInvite(orgB.id, adminB.id, { email: null, role: 'viewer' });
      stubGoogle({ guest: { email: 'guest@multi.local', sub: 'g-guest' } });

      expect(await googleCallback('guest', inviteToB.token)).not.toContain('error=');
      expect(await membershipsIn(orgB.id)).toHaveLength(2);
    });
  });
});
