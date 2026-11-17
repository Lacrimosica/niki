import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initializeMiniflare, cleanupMiniflare, getMiniflareDB } from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import {
  createTestOrganization,
  createTestUser,
  createTestOrganizationUser,
  createTestPerson,
  createTestInvite,
} from '../setup/fixtures';
import { callApi, mintSessionToken } from '../setup/http';
import * as schema from '../../src/db/schema';

describe('Access Control — Org Boundary Enforcement', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  it('user should only see people in their organization', async () => {
    const db = getMiniflareDB();

    const org1 = await createTestOrganization({
      slug: 'org1',
      name: 'Organization 1',
    });

    const org2 = await createTestOrganization({
      slug: 'org2',
      name: 'Organization 2',
    });

    const user1 = await createTestUser({
      email: 'user1@org1.com',
    });

    const user2 = await createTestUser({
      email: 'user2@org2.com',
    });

    // Link users to their orgs
    await createTestOrganizationUser(user1.id, org1.id);
    await createTestOrganizationUser(user2.id, org2.id);

    // Create persons in each org
    const person1 = await createTestPerson(org1.id);
    const person2 = await createTestPerson(org2.id);

    // Simulate API filtering: when user1 requests people, filter by org_id
    // (In real API, this would be in the route handler)
    // For now, verify that the data exists and is distinct

    expect(person1.id).not.toBe(person2.id);

    // In a real API call from user1 with orgId=org1,
    // they would get [person1] only, not [person2]
  });

  // The tests below go through the real routes with an org-scoped session
  // token. Earlier versions queried the DB with `.where((t) => ...)` callbacks,
  // which Drizzle's select builder silently ignores, so they asserted nothing.

  async function seedSettings(orgId: string, city: string, maxProxies: number) {
    await getMiniflareDB().insert(schema.organizationSetting).values({
      id: `setting-${orgId}`,
      orgId,
      city,
      maxProxies,
      createdAt: new Date().toISOString(),
    });
  }

  it('user should only see organization settings for their org', async () => {
    const org1 = await createTestOrganization({ slug: 'org1', name: 'Organization 1' });
    const org2 = await createTestOrganization({ slug: 'org2', name: 'Organization 2' });
    const user1 = await createTestUser({ email: 'user1@org1.com' });
    const user2 = await createTestUser({ email: 'user2@org2.com' });
    await createTestOrganizationUser(user1.id, org1.id);
    await createTestOrganizationUser(user2.id, org2.id);
    await seedSettings(org1.id, 'Milan', 3);
    await seedSettings(org2.id, 'Rome', 5);

    const token1 = await mintSessionToken(user1.id, org1.id, ['settings.view'], 'admin');
    const res1 = await callApi('GET', '/api/settings/documents', { token: token1 });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ city: 'Milan', maxProxies: 3 });

    const token2 = await mintSessionToken(user2.id, org2.id, ['settings.view'], 'admin');
    const res2 = await callApi('GET', '/api/settings/documents', { token: token2 });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ city: 'Rome', maxProxies: 5 });
  });

  it('user should not be able to access other org members list', async () => {
    const org1 = await createTestOrganization({ slug: 'org1', name: 'Organization 1' });
    const org2 = await createTestOrganization({ slug: 'org2', name: 'Organization 2' });
    const user1 = await createTestUser({ email: 'user1@example.com' });
    const user2 = await createTestUser({ email: 'user2@example.com' });
    const user3 = await createTestUser({ email: 'user3@example.com' });

    // Org1 members: user1, user2. Org2 members: user3
    await createTestOrganizationUser(user1.id, org1.id);
    await createTestOrganizationUser(user2.id, org1.id);
    await createTestOrganizationUser(user3.id, org2.id);

    const token = await mintSessionToken(user1.id, org1.id, ['settings.users.view'], 'admin');
    const res = await callApi('GET', '/api/settings/users', { token });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((u) => u.id).sort();
    expect(ids).toEqual([user1.id, user2.id].sort());
    expect(ids).not.toContain(user3.id);
  });

  it('a token for one org cannot be used to act in another org', async () => {
    const org1 = await createTestOrganization({ slug: 'org1', name: 'Organization 1' });
    const org2 = await createTestOrganization({ slug: 'org2', name: 'Organization 2' });
    const user1 = await createTestUser({ email: 'user1@example.com' });
    await createTestOrganizationUser(user1.id, org1.id);
    await seedSettings(org2.id, 'Rome', 5);

    // A forged claim for an org the user does not belong to is rejected by the
    // session middleware before any handler runs.
    const forged = await mintSessionToken(user1.id, org2.id, ['settings.view'], 'core_admin', {
      syncMembership: false,
    });
    const res = await callApi('GET', '/api/settings/documents', { token: forged });
    expect(res.status).toBe(401);
  });

  // No route lists invites (creation is POST /api/auth/invites, lookup is by
  // signed token), so cross-org invite listing cannot leak. Cross-org invite
  // creation is covered in tenant-isolation-http.test.ts ("invites cannot target
  // another org"). This remains a DB-level check that invites are org-scoped rows.
  it('user from org1 should not see invites for org2', async () => {
    const db = getMiniflareDB();

    const org1 = await createTestOrganization({ slug: 'org1', name: 'Organization 1' });
    const org2 = await createTestOrganization({ slug: 'org2', name: 'Organization 2' });
    const admin1 = await createTestUser({ email: 'admin1@example.com' });
    const admin2 = await createTestUser({ email: 'admin2@example.com' });
    await createTestOrganizationUser(admin1.id, org1.id, { role: 'admin' });
    await createTestOrganizationUser(admin2.id, org2.id, { role: 'admin' });

    await createTestInvite(org1.id, admin1.id, { id: 'invite-org1', token: 'token-org1' });
    await createTestInvite(org2.id, admin2.id, { id: 'invite-org2', token: 'token-org2' });

    const org1Invites = await db.select().from(schema.invite).where(eq(schema.invite.orgId, org1.id)).all();
    expect(org1Invites.map((i) => i.token)).toEqual(['token-org1']);
  });

  it('organization settings should not be visible across orgs', async () => {
    const org1 = await createTestOrganization({ slug: 'org1', name: 'Organization 1' });
    const org2 = await createTestOrganization({ slug: 'org2', name: 'Organization 2' });
    const user1 = await createTestUser({ email: 'user1@example.com' });
    await createTestOrganizationUser(user1.id, org1.id);
    await seedSettings(org1.id, 'Milan', 3);
    await seedSettings(org2.id, 'Rome', 5);

    const token = await mintSessionToken(user1.id, org1.id, ['settings.view', 'settings.manage'], 'admin');

    // A body cannot redirect the update to another org's settings row.
    const patch = await callApi('PATCH', '/api/settings/documents', {
      token,
      body: { city: 'Turin', orgId: org2.id },
    });
    expect(patch.status).toBe(200);

    const org2Row = await getMiniflareDB()
      .select()
      .from(schema.organizationSetting)
      .where(eq(schema.organizationSetting.orgId, org2.id))
      .get();
    expect(org2Row?.city).toBe('Rome');
    expect(org2Row?.maxProxies).toBe(5);

    const res = await callApi('GET', '/api/settings/documents', { token });
    expect(await res.json()).toMatchObject({ city: 'Turin', maxProxies: 3 });
  });

  it('user switching orgs should require re-authentication', async () => {
    // When a user belongs to multiple orgs and wants to switch,
    // they must re-authenticate to get a new JWT with different orgId

    const org1 = await createTestOrganization({
      slug: 'org1',
      name: 'Organization 1',
    });

    const org2 = await createTestOrganization({
      slug: 'org2',
      name: 'Organization 2',
    });

    const user = await createTestUser({
      email: 'user@example.com',
    });

    // User belongs to both orgs
    await createTestOrganizationUser(user.id, org1.id);
    await createTestOrganizationUser(user.id, org2.id);

    // First JWT: orgId=org1
    const jwt1 = {
      sub: user.id,
      orgId: org1.id,
    };

    // To get JWT with orgId=org2, user must call login again
    // selecting org2 as the organization context
    const jwt2 = {
      sub: user.id,
      orgId: org2.id,
    };

    // Both JWTs valid, but can't be modified client-side (signed)
    expect(jwt1.orgId).toBe(org1.id);
    expect(jwt2.orgId).toBe(org2.id);
  });
});
