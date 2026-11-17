import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initializeMiniflare, cleanupMiniflare, getMiniflareDB, getMiniflareRawDB } from '../setup/miniflare-context';
import { createTestOrganization } from '../setup/fixtures';
import { resetTestDatabase } from '../setup/db-reset';
import * as schema from '../../src/db/schema';

describe('Database Migrations', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  it('all required tables should exist after migrations', async () => {
    // Drizzle's db.all() takes a SQL object, not a string; use the raw D1 binding.
    const result = await getMiniflareRawDB()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all<{ name: string }>();

    const tableNames = (result.results || []).map((row) => row.name);

    expect(tableNames).toContain('person');
    expect(tableNames).toContain('organization');
    expect(tableNames).toContain('user');
    expect(tableNames).toContain('organization_user');
    expect(tableNames).toContain('assembly');
    expect(tableNames).toContain('attendance');
    expect(tableNames).toContain('organization_setting');
    expect(tableNames).toContain('invite');
    expect(tableNames).toContain('audit_event');
    expect(tableNames).toContain('setup_attempt');
  });

  it('lookup tables should be seeded without duplicates', async () => {
    const db = getMiniflareDB();

    // Check assembly_type lookup table
    const assemblyTypes = await db.select().from(schema.assemblyType).all();
    const ids = assemblyTypes.map((t) => t.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('organization_setting should have compliance_rules column', async () => {
    const db = getMiniflareDB();

    // Create a test setting
    await db.insert(schema.organizationSetting).values({
      id: 'test-setting',
      complianceRules: JSON.stringify({}),
      createdAt: new Date().toISOString(),
    });

    const setting = await db
      .select()
      .from(schema.organizationSetting)
      .where(eq(schema.organizationSetting.id, 'test-setting'))
      .get();

    expect(setting).toBeTruthy();
    expect(setting?.complianceRules).toBeDefined();
  });

  it('organization table should have required columns', async () => {
    const db = getMiniflareDB();

    const org = await db.insert(schema.organization).values({
      id: 'test-org',
      name: 'Test',
      shortName: 'T',
      slug: 'test-slug',
      isSetupComplete: 0,
      createdAt: new Date().toISOString(),
    });

    const retrieved = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, 'test-org'))
      .get();

    expect(retrieved).toBeTruthy();
    expect(retrieved?.name).toBe('Test');
    expect(retrieved?.isSetupComplete).toBe(0);
  });

  it('volunteer_period should support both old and new status columns', async () => {
    const db = getMiniflareDB();
    // person.org_id and volunteer_period.org_id are NOT NULL since migration 0065.
    const org = await createTestOrganization();

    // First create a person
    const person = await db
      .insert(schema.person)
      .values({
        id: 'test-person',
        orgId: org.id,
        firstName: 'Test',
        lastName: 'Person',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

    // Legacy text 'status' plus the Phase 3 FK into the seeded volunteer_status lookup
    const period = await db
      .insert(schema.volunteerPeriod)
      .values({
        id: 'test-period',
        orgId: org.id,
        personId: 'test-person',
        status: 'active',
        statusId: 'vstatus-01',
        enrollmentDate: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });

    const retrieved = await db
      .select()
      .from(schema.volunteerPeriod)
      .where(eq(schema.volunteerPeriod.id, 'test-period'))
      .get();

    expect(retrieved).toBeTruthy();
    expect(retrieved?.status).toBe('active');
    expect(retrieved?.statusId).toBe('vstatus-01');
  });
});
