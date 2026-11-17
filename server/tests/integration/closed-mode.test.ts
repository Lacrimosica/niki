import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initializeMiniflare, cleanupMiniflare, getMiniflareDB } from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import { createTestOrganization, createTestUser, createTestOrganizationUser } from '../setup/fixtures';
import * as schema from '../../src/db/schema';
import { callApi, mintSetupToken } from '../setup/http';

describe('Closed Mode — No New Organizations', () => {
  beforeEach(async () => {
    await initializeMiniflare('closed');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  const setupBody = {
    orgName: 'New Org',
    shortName: 'NO',
    slug: 'new-org',
    adminEmail: 'admin@new-org.local',
    adminPassword: 'a-long-enough-password',
  };

  it('setup endpoint should return 423 Locked in closed mode', async () => {
    await createTestOrganization({ slug: 'existing-org', name: 'Existing Organization', isSetupComplete: 1 });

    const tokenRes = await callApi('GET', '/api/setup/token', { mode: 'closed' });
    expect(tokenRes.status).toBe(423);

    // Even with a validly signed setup token, creation is refused.
    const res = await callApi('POST', '/api/setup', {
      mode: 'closed',
      token: await mintSetupToken(),
      body: setupBody,
    });
    expect(res.status).toBe(423);
  });

  it('existing users can still access their organizations', async () => {
    const db = getMiniflareDB();

    // Setup existing org and user
    const org = await createTestOrganization({
      slug: 'frozen-org',
      name: 'Frozen Organization',
    });

    const user = await createTestUser({
      email: 'frozen-user@example.com',
    });

    const orgUser = await createTestOrganizationUser(user.id, org.id, {
      role: 'admin',
      isOwner: 1,
    });

    // Verify user still has access
    const retrieved = await db
      .select()
      .from(schema.organizationUser)
      .where(eq(schema.organizationUser.id, orgUser.id))
      .get();

    expect(retrieved).toBeTruthy();
    expect(retrieved?.userId).toBe(user.id);
    expect(retrieved?.orgId).toBe(org.id);
  });

  it('new organization creation should be blocked', async () => {
    const db = getMiniflareDB();

    // Also refused on a fresh database: closed mode has no first-org exception.
    const res = await callApi('POST', '/api/setup', {
      mode: 'closed',
      token: await mintSetupToken(),
      body: setupBody,
    });
    expect(res.status).toBe(423);

    expect(await db.select().from(schema.organization).all()).toHaveLength(0);
    expect(await db.select().from(schema.user).all()).toHaveLength(0);
    expect(await db.select().from(schema.auditEvent).all()).toHaveLength(0);
  });

  // The original version only checked that the audit_event table exists (now
  // covered in migrations.test.ts). src/routes/setup.ts audits successful org
  // creation only; rejected closed-mode attempts are not recorded anywhere.
  // Follow-up: decide whether the setup rate-limiting branch's attempt tracking
  // should cover this, then assert it here over HTTP.
  it.skip('audit logging should record setup attempts', async () => {
    await callApi('POST', '/api/setup', { mode: 'closed', token: await mintSetupToken(), body: setupBody });
    const events = await getMiniflareDB().select().from(schema.auditEvent).all();
    expect(events.length).toBeGreaterThan(0);
  });
});
