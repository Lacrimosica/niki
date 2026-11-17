import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initializeMiniflare, cleanupMiniflare, getMiniflareDB } from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import { mockTime, advanceTime, resetTime } from '../setup/mocks/time';
import { createTestOrganization, createTestUser, createTestInvite } from '../setup/fixtures';
import * as schema from '../../src/db/schema';
import { callApi, mintSetupToken } from '../setup/http';

describe('Invite Token Validation — invite_only Mode', () => {
  beforeEach(async () => {
    await initializeMiniflare('invite_only');
    await resetTestDatabase();
    mockTime(Date.now());
  });

  afterEach(async () => {
    resetTime();
    await cleanupMiniflare();
  });

  it('valid invite token should allow org creation', async () => {
    const db = getMiniflareDB();
    const org = await createTestOrganization({
      slug: 'first-org',
      name: 'First Organization',
    });

    const issuer = await createTestUser({
      email: 'admin@example.com',
    });

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const invite = {
      id: 'invite-1',
      orgId: org.id,
      email: 'invitee@example.com',
      token: 'valid-token-123',
      role: 'member',
      createdByUserId: issuer.id,
      expiresAt,
      createdAt: new Date().toISOString(),
    };

    await db.insert(schema.invite).values(invite);

    const retrieved = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, 'valid-token-123'))
      .get();

    expect(retrieved).toBeTruthy();
    expect(retrieved?.token).toBe('valid-token-123');
    expect(retrieved?.usedAt).toBeNull(); // Not used yet
  });

  it('expired invite token should be rejected', async () => {
    const db = getMiniflareDB();
    const org = await createTestOrganization({
      slug: 'org-with-expired-invite',
      name: 'Organization',
    });

    const issuer = await createTestUser({
      email: 'admin@example.com',
    });

    // Create expired invite (24 hours ago)
    const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const invite = {
      id: 'expired-invite',
      orgId: org.id,
      email: 'invitee@example.com',
      token: 'expired-token-123',
      role: 'member',
      createdByUserId: issuer.id,
      expiresAt,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };

    await db.insert(schema.invite).values(invite);

    const retrieved = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, 'expired-token-123'))
      .get();

    const now = new Date();
    const isExpired = new Date(retrieved!.expiresAt) < now;
    expect(isExpired).toBe(true);
  });

  it('already-used invite token should be rejected', async () => {
    const db = getMiniflareDB();
    const org = await createTestOrganization({
      slug: 'org-with-used-invite',
      name: 'Organization',
    });

    const issuer = await createTestUser({
      email: 'admin@example.com',
    });

    const user = await createTestUser({
      email: 'invitee@example.com',
    });

    const usedAt = new Date().toISOString();

    const invite = {
      id: 'used-invite',
      orgId: org.id,
      email: 'invitee@example.com',
      token: 'used-token-123',
      role: 'member',
      createdByUserId: issuer.id,
      usedAt, // Already used
      usedByUserId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    await db.insert(schema.invite).values(invite);

    const retrieved = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, 'used-token-123'))
      .get();

    expect(retrieved?.usedAt).not.toBeNull();
  });

  it('invalid (non-existent) invite token should be rejected', async () => {
    const db = getMiniflareDB();

    const invites = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, 'non-existent-token'))
      .all();

    expect(invites.length).toBe(0);
  });

  it('invite token should be marked as used after org creation', async () => {
    const db = getMiniflareDB();
    const org = await createTestOrganization({
      slug: 'org-will-use-invite',
      name: 'Organization',
    });

    const issuer = await createTestUser({
      email: 'admin@example.com',
    });

    const user = await createTestUser({
      email: 'new-user@example.com',
    });

    const now = new Date().toISOString();
    const invite = {
      id: 'invite-to-mark-used',
      orgId: org.id,
      email: 'new-user@example.com',
      token: 'mark-as-used-token',
      role: 'member',
      createdByUserId: issuer.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: now,
    };

    await db.insert(schema.invite).values(invite);

    // Simulate marking as used
    await db
      .update(schema.invite)
      .set({
        usedAt: now,
        usedByUserId: user.id,
      })
      .where(eq(schema.invite.token, 'mark-as-used-token'))
      .run();

    const updated = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, 'mark-as-used-token'))
      .get();

    expect(updated?.usedAt).not.toBeNull();
    expect(updated?.usedByUserId).toBe(user.id);
  });

  // HTTP-level coverage of the org-creation invite on POST /api/setup. The DB
  // round-trip tests above only check that columns store what is written.
  // NOTE: a parallel branch adds an invite `kind` column and rewrites redemption;
  // createTestInvite may then need `kind: 'org_creation'` for these to pass.
  describe('POST /api/setup with an org-creation token', () => {
    async function setup(orgCreationToken: string | undefined, suffix: string) {
      return callApi('POST', '/api/setup', {
        mode: 'invite_only',
        token: await mintSetupToken(),
        body: {
          orgName: `Org ${suffix}`,
          shortName: `O${suffix}`,
          slug: `org-${suffix}`,
          adminEmail: `admin-${suffix}@example.com`,
          adminPassword: 'a-long-enough-password',
          orgCreationToken,
        },
      });
    }

    async function seedFirstOrgWithInvite(overrides: Parameters<typeof createTestInvite>[2] = {}) {
      const org = await createTestOrganization({ slug: 'first-org', name: 'First Organization' });
      const issuer = await createTestUser({ email: 'issuer@example.com' });
      // Only org-creation invites may be used to create an organization.
      return createTestInvite(org.id, issuer.id, { kind: 'org_creation', email: null, ...overrides });
    }

    it('requires a token once an organization exists', async () => {
      await seedFirstOrgWithInvite();
      expect((await setup(undefined, 'a')).status).toBe(403);
      expect((await setup('no-such-token', 'b')).status).toBe(403);
    });

    it('accepts a valid token once, marks it used, and rejects reuse', async () => {
      const invite = await seedFirstOrgWithInvite();

      const first = await setup(invite.token, 'a');
      expect(first.status).toBe(200);

      const db = getMiniflareDB();
      const used = await db.select().from(schema.invite).where(eq(schema.invite.token, invite.token)).get();
      expect(used?.usedAt).not.toBeNull();
      const newAdmin = await db.select().from(schema.user).where(eq(schema.user.email, 'admin-a@example.com')).get();
      expect(used?.usedByUserId).toBe(newAdmin?.id);

      const second = await setup(invite.token, 'b');
      expect(second.status).toBe(403);
      expect(await db.select().from(schema.organization).where(eq(schema.organization.slug, 'org-b')).get()).toBeUndefined();
    });

    it('rejects an expired token', async () => {
      const invite = await seedFirstOrgWithInvite({
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      expect((await setup(invite.token, 'a')).status).toBe(403);
    });
  });
});
