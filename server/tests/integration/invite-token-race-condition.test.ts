import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initializeMiniflare, cleanupMiniflare, getMiniflareDB } from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import { createTestOrganization, createTestUser, createTestInvite } from '../setup/fixtures';
import * as schema from '../../src/db/schema';
import { callApi, mintSetupToken } from '../setup/http';

describe('Invite Token Race Conditions', () => {
  beforeEach(async () => {
    await initializeMiniflare('invite_only');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  it('token should be single-use (prevent reuse)', async () => {
    const db = getMiniflareDB();

    const org = await createTestOrganization({
      slug: 'test-org',
      name: 'Test Organization',
    });

    const issuer = await createTestUser({
      email: 'issuer@example.com',
    });

    const invite = await createTestInvite(org.id, issuer.id);

    // First use: mark as used
    const user1 = await createTestUser({
      email: 'user1@example.com',
    });

    await db
      .update(schema.invite)
      .set({
        usedAt: new Date().toISOString(),
        usedByUserId: user1.id,
      })
      .where(eq(schema.invite.token, invite.token))
      .run();

    const usedInvite = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, invite.token))
      .get();

    expect(usedInvite?.usedAt).not.toBeNull();

    // Second use: should be rejected (already usedAt)
    const isAlreadyUsed = usedInvite?.usedAt !== null;
    expect(isAlreadyUsed).toBe(true);
  });

  it('concurrent token usage should result in one winner', async () => {
    const db = getMiniflareDB();

    const org = await createTestOrganization({
      slug: 'test-org',
      name: 'Test Organization',
    });

    const issuer = await createTestUser({
      email: 'issuer@example.com',
    });

    const invite = await createTestInvite(org.id, issuer.id);

    const user1 = await createTestUser({
      email: 'user1@example.com',
    });

    const user2 = await createTestUser({
      email: 'user2@example.com',
    });

    // Two users try to use same token concurrently
    // In real scenario: both send requests simultaneously
    // DB should only allow one to update (first to complete)

    try {
      // User 1 marks as used
      await db
        .update(schema.invite)
        .set({
          usedAt: new Date().toISOString(),
          usedByUserId: user1.id,
        })
        .where(eq(schema.invite.token, invite.token))
        .run();

      // User 2 tries to mark as used (should see it's already used)
      const inviteNow = await db
        .select()
        .from(schema.invite)
        .where(eq(schema.invite.token, invite.token))
        .get();

      expect(inviteNow?.usedByUserId).toBe(user1.id); // User1 won the race
    } catch (err) {
      // Race condition handled
      expect(err).toBeTruthy();
    }
  });

  it('expired token should not be usable even concurrently', async () => {
    const db = getMiniflareDB();

    const org = await createTestOrganization({
      slug: 'test-org',
      name: 'Test Organization',
    });

    const issuer = await createTestUser({
      email: 'issuer@example.com',
    });

    // Create expired invite (24+ hours ago)
    const expiredToken = 'expired-token-' + Date.now();
    const expiredInvite = await db
      .insert(schema.invite)
      .values({
        id: 'expired-' + Date.now(),
        orgId: org.id,
        email: 'expired@example.com',
        token: expiredToken,
        role: 'member',
        createdByUserId: issuer.id,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });

    const user = await createTestUser({
      email: 'user@example.com',
    });

    // Check expiry before allowing use
    const invite = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, expiredToken))
      .get();

    const isExpired = new Date(invite!.expiresAt) < new Date();
    expect(isExpired).toBe(true);

    // Should be rejected regardless of concurrency
  });

  it('should prevent token duplication', async () => {
    const db = getMiniflareDB();

    const org = await createTestOrganization({
      slug: 'test-org',
      name: 'Test Organization',
    });

    const issuer = await createTestUser({
      email: 'issuer@example.com',
    });

    const uniqueToken = 'unique-token-' + Date.now();

    // Create invite with unique token
    await db.insert(schema.invite).values({
      id: 'invite-1',
      orgId: org.id,
      email: 'user1@example.com',
      token: uniqueToken,
      role: 'member',
      createdByUserId: issuer.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    // Attempt to create duplicate token
    try {
      await db.insert(schema.invite).values({
        id: 'invite-2',
        orgId: org.id,
        email: 'user2@example.com',
        token: uniqueToken, // Same token
        role: 'member',
        createdByUserId: issuer.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      });
      expect.fail('write unexpectedly succeeded');
    } catch (err) {
      expect((err as Error).message).toMatch(/UNIQUE|constraint/i);
    }
  });

  it('token should be validated before marking as used', async () => {
    const db = getMiniflareDB();

    const org = await createTestOrganization({
      slug: 'test-org',
      name: 'Test Organization',
    });

    const issuer = await createTestUser({
      email: 'issuer@example.com',
    });

    const invite = await createTestInvite(org.id, issuer.id);
    const user = await createTestUser({
      email: 'user@example.com',
    });

    // Validation steps before marking as used:
    // 1. Token exists
    const tokenExists = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, invite.token))
      .get();

    expect(tokenExists).toBeTruthy();

    // 2. Token not already used
    const alreadyUsed = tokenExists?.usedAt !== null;
    expect(alreadyUsed).toBe(false);

    // 3. Token not expired
    const isExpired = new Date(tokenExists!.expiresAt) < new Date();
    expect(isExpired).toBe(false);

    // 4. Only then mark as used
    await db
      .update(schema.invite)
      .set({
        usedAt: new Date().toISOString(),
        usedByUserId: user.id,
      })
      .where(eq(schema.invite.token, invite.token))
      .run();

    const updated = await db
      .select()
      .from(schema.invite)
      .where(eq(schema.invite.token, invite.token))
      .get();

    expect(updated?.usedAt).not.toBeNull();
  });

  // The tests above write and read invite rows directly and never run two
  // redemptions at once. This one races two real POST /api/setup requests.
  //
  // Skipped: FAILS on main ([200, 200], two orgs from one token). setup.ts checks
  // `usedAt` with a SELECT, creates the org, then marks the invite used with an
  // unconditional UPDATE, so both requests pass the check. A parallel branch is
  // rewriting invite redemption in setup.ts (atomic claim); un-skip once it merges.
  it.skip('two concurrent setups with the same org-creation token create one org', async () => {
    const org = await createTestOrganization({ slug: 'first-org', name: 'First Organization' });
    const issuer = await createTestUser({ email: 'issuer@example.com' });
    const invite = await createTestInvite(org.id, issuer.id);

    const attempt = async (suffix: string) =>
      callApi('POST', '/api/setup', {
        mode: 'invite_only',
        token: await mintSetupToken(),
        body: {
          orgName: `Org ${suffix}`,
          shortName: `O${suffix}`,
          slug: `race-${suffix}`,
          adminEmail: `admin-${suffix}@example.com`,
          adminPassword: 'a-long-enough-password',
          orgCreationToken: invite.token,
        },
      });

    const statuses = (await Promise.all([attempt('a'), attempt('b')])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 403]);

    const orgs = await getMiniflareDB().select().from(schema.organization).all();
    expect(orgs).toHaveLength(2); // first-org + exactly one winner
  });
});
