import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { createTestOrganization, createTestUser, createTestOrganizationUser } from '../setup/fixtures';
import * as schema from '../../src/db/schema';

const JWT_SECRET = 'test-jwt-secret-min-32-characters-long!!';

/**
 * The member-links panel is shown to anyone with people.view (client gate in
 * AssemblyDetail). Its endpoints once checked a deprecated `members.view`
 * permission that no role grants, so every caller got 403.
 */
describe('Member links — permission gate', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  async function mintToken(userId: string, orgId: string, permissions: string[]) {
    await getMiniflareDB().update(schema.organizationUser)
      .set({ role: 'core_admin', permissions: JSON.stringify(permissions) })
      .where(and(eq(schema.organizationUser.userId, userId), eq(schema.organizationUser.orgId, orgId)))
      .run();
    return sign(
      {
        sub: userId,
        email: `${userId}@test.local`,
        orgId,
        role: 'core_admin',
        permissions,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      JWT_SECRET,
    );
  }

  const env = () => ({ DB: getMiniflareRawDB(), JWT_SECRET });

  async function seedUser() {
    const org = await createTestOrganization({ slug: 'links-org', name: 'Links Org' });
    const user = await createTestUser({ email: 'viewer@links.local' });
    await createTestOrganizationUser(user.id, org.id, { role: 'core_admin' });
    return { org, user };
  }

  it('lets a people.view caller read unlinked members', async () => {
    const { org, user } = await seedUser();
    const token = await mintToken(user.id, org.id, ['people.view']);

    const res = await app.request(
      '/api/periods/members/unlinked',
      { headers: { Authorization: `Bearer ${token}` } },
      env(),
    );
    expect(res.status).toBe(200);
  });

  it('lets a people.view caller read an assembly’s member links', async () => {
    const { org, user } = await seedUser();
    const token = await mintToken(user.id, org.id, ['people.view']);

    const res = await app.request(
      '/api/assemblies/does-not-exist/member-links',
      { headers: { Authorization: `Bearer ${token}` } },
      env(),
    );
    // Passes the permission gate; the unknown assembly is then a 404, not a 403.
    expect(res.status).not.toBe(403);
  });

  it('refuses both endpoints to a caller without people.view', async () => {
    const { org, user } = await seedUser();
    const token = await mintToken(user.id, org.id, ['assemblies.view']);

    const unlinked = await app.request(
      '/api/periods/members/unlinked',
      { headers: { Authorization: `Bearer ${token}` } },
      env(),
    );
    const links = await app.request(
      '/api/assemblies/does-not-exist/member-links',
      { headers: { Authorization: `Bearer ${token}` } },
      env(),
    );
    expect(unlinked.status).toBe(403);
    expect(links.status).toBe(403);
  });
});
