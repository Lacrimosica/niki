import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { sign } from 'hono/jwt';
import { zipSync, strToU8 } from 'fflate';
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
const MIGRATION = path.join(__dirname, '../../drizzle/migrations/dev/0070_grant_data_permissions.sql');

describe('Export/import permissions and audit', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  async function seed(role: string, permissions: string[]) {
    const org = await createTestOrganization({ slug: 'org1', name: 'Org 1' });
    const user = await createTestUser({ email: 'someone@org1.local' });
    await createTestOrganizationUser(user.id, org.id, { role, permissions: JSON.stringify(permissions) });
    const token = await sign(
      { sub: user.id, email: user.email, orgId: org.id, role, permissions, typ: 'session', tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    );
    return { org, user, token };
  }

  function env() {
    return { DB: getMiniflareRawDB(), JWT_SECRET };
  }

  function exportRequest(token: string) {
    return app.request(
      '/api/export',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tables: ['people'] }),
      },
      env(),
    );
  }

  function importRequest(token: string) {
    const zip = zipSync({
      'MANIFEST.json': strToU8(JSON.stringify({ tables: ['people'] })),
      'people.tsv': strToU8(`id\tfirstName\tlastName\n${crypto.randomUUID()}\tAda\tLovelace\n`),
    });
    const form = new FormData();
    form.append('file', new File([zip], 'backup.zip', { type: 'application/zip' }));
    return app.request('/api/import', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }, env());
  }

  async function auditRows(eventType: string) {
    return getMiniflareDB().select().from(schema.auditEvent).where(eq(schema.auditEvent.eventType, eventType)).all();
  }

  it('denies export to an admin without data.export', async () => {
    const { token } = await seed('admin', ['settings.view']);
    const res = await exportRequest(token);
    expect(res.status).toBe(403);
    expect(await auditRows('data_export')).toHaveLength(0);
  });

  it('allows export with data.export regardless of role and audits it', async () => {
    const { org, user, token } = await seed('manager', ['data.export']);
    const res = await exportRequest(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');

    const rows = await auditRows('data_export');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(user.id);
    expect(rows[0].orgId).toBe(org.id);
    expect(JSON.parse(rows[0].payload ?? '{}').tables).toEqual(['people']);
  });

  it('denies import to a core_admin without data.import', async () => {
    const { token } = await seed('core_admin', ['data.export']);
    const res = await importRequest(token);
    expect(res.status).toBe(403);
    expect(await auditRows('data_import')).toHaveLength(0);
  });

  it('allows import with data.import and audits it', async () => {
    const { org, user, token } = await seed('admin', ['data.import']);
    const res = await importRequest(token);
    expect(res.status).toBe(200);

    const rows = await auditRows('data_import');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(user.id);
    expect(rows[0].orgId).toBe(org.id);
    const payload = JSON.parse(rows[0].payload ?? '{}');
    expect(payload.succeeded).toBe(true);
    expect(payload.rowCounts.people).toBe(1);
  });

  it('migration 0070 grants the new permissions to existing admins only', async () => {
    const org = await createTestOrganization({ slug: 'org1', name: 'Org 1' });
    const members = {
      admin: ['people.view'],
      core_admin: ['people.view', 'data.export'],
      manager: ['people.view'],
      viewer: ['people.view'],
    } as const;
    const ids: Record<string, string> = {};
    for (const [role, perms] of Object.entries(members)) {
      const u = await createTestUser({ email: `${role}@org1.local` });
      ids[role] = u.id;
      await createTestOrganizationUser(u.id, org.id, { role, permissions: JSON.stringify(perms) });
    }
    const broken = await createTestUser({ email: 'broken@org1.local' });
    await createTestOrganizationUser(broken.id, org.id, { role: 'admin', permissions: 'not json' });

    const sql = fs.readFileSync(MIGRATION, 'utf-8');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await getMiniflareRawDB().prepare(statement).run();
    }

    const permsOf = async (userId: string) => {
      const row = await getMiniflareDB().select().from(schema.organizationUser)
        .where(and(eq(schema.organizationUser.userId, userId), eq(schema.organizationUser.orgId, org.id)))
        .get();
      return row?.permissions;
    };
    expect(JSON.parse((await permsOf(ids.admin)) ?? '[]')).toEqual(['people.view', 'data.export', 'data.import']);
    expect(JSON.parse((await permsOf(ids.core_admin)) ?? '[]')).toEqual(['people.view', 'data.export', 'data.import']);
    expect(JSON.parse((await permsOf(ids.manager)) ?? '[]')).toEqual(['people.view']);
    expect(JSON.parse((await permsOf(ids.viewer)) ?? '[]')).toEqual(['people.view']);
    expect(await permsOf(broken.id)).toBe('not json');
  });
});
