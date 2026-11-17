import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import app from '../../src/index';
import { initializeMiniflare, cleanupMiniflare, getMiniflareRawDB } from '../setup/miniflare-context';
import { resetTestDatabase } from '../setup/db-reset';
import { createTestOrganization, createTestUser, createTestOrganizationUser } from '../setup/fixtures';
import { hashPassword } from '../../src/lib/auth';
import { RATE_LIMITS, TOO_MANY_REQUESTS_CODE, consumeRateLimit } from '../../src/lib/rate-limit';

const JWT_SECRET = 'test-jwt-secret-min-32-characters-long!!';
const PASSWORD = 'correct-horse-battery-staple';

/**
 * Drives the real login and setup routes in-process. Requests carry
 * cf-connecting-ip the way Cloudflare's edge would set it.
 */
describe('Rate limiting — login and setup', () => {
  beforeEach(async () => {
    await initializeMiniflare('open');
    await resetTestDatabase();
  });

  afterEach(async () => {
    await cleanupMiniflare();
  });

  function env() {
    return { DB: getMiniflareRawDB(), JWT_SECRET, DEPLOYMENT_MODE: 'open' };
  }

  function login(email: string, password: string, ip?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ip) headers['cf-connecting-ip'] = ip;
    return app.request(
      '/api/auth/login',
      { method: 'POST', headers, body: JSON.stringify({ email, password }) },
      env(),
    );
  }

  async function createLoginUser(email: string) {
    const org = await createTestOrganization();
    const user = await createTestUser({ email, password: await hashPassword(PASSWORD) });
    await createTestOrganizationUser(user.id, org.id, { role: 'core_admin' });
    return user;
  }

  async function expectTooMany(res: Response): Promise<number> {
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    // Exactly this body and nothing else, so no bucket or account detail leaks.
    expect(await res.json()).toEqual({ error: TOO_MANY_REQUESTS_CODE });
    return retryAfter;
  }

  describe('POST /api/auth/login', () => {
    it('rejects the 11th attempt from one IP within a minute', async () => {
      const ip = '203.0.113.10';
      // Distinct emails so only the per-IP bucket can trip.
      for (let i = 0; i < 10; i++) {
        const res = await login(`nobody-${i}@test.local`, 'wrong', ip);
        expect(res.status).toBe(401);
      }
      await expectTooMany(await login('nobody-10@test.local', 'wrong', ip));

      // Another IP is unaffected.
      expect((await login('nobody-11@test.local', 'wrong', '203.0.113.11')).status).toBe(401);
    });

    it('limits attempts per email across different IPs, even with the right password', async () => {
      await createLoginUser('victim@test.local');

      for (let i = 0; i < 5; i++) {
        const res = await login('victim@test.local', 'wrong', `198.51.100.${i + 1}`);
        expect(res.status).toBe(401);
      }
      // Case and whitespace variants share the bucket.
      await expectTooMany(await login('  Victim@Test.local ', 'wrong', '198.51.100.50'));
      await expectTooMany(await login('victim@test.local', PASSWORD, '198.51.100.51'));

      // Other accounts from the same IP still get normal handling.
      expect((await login('someone-else@test.local', 'wrong', '198.51.100.51')).status).toBe(401);
    });

    it('returns the same body and Retry-After whichever login bucket tripped', async () => {
      for (let i = 0; i < 10; i++) await login(`spray-${i}@test.local`, 'wrong', '203.0.113.60');
      const ipRetry = await expectTooMany(await login('spray-10@test.local', 'wrong', '203.0.113.60'));

      for (let i = 0; i < 5; i++) await login('target@test.local', 'wrong', `203.0.113.${70 + i}`);
      const emailRetry = await expectTooMany(await login('target@test.local', 'wrong', '203.0.113.80'));

      expect(ipRetry).toBe(emailRetry);
    });

    it('applies the same per-email limit to unknown emails, so 429 reveals nothing', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await login('ghost@test.local', 'wrong', `192.0.2.${i + 1}`)).status).toBe(401);
      }
      await expectTooMany(await login('ghost@test.local', 'wrong', '192.0.2.99'));
    });

    it('clears the per-email failure count after a successful login', async () => {
      await createLoginUser('member@test.local');

      for (let i = 0; i < 4; i++) {
        expect((await login('member@test.local', 'wrong', `192.0.2.${i + 1}`)).status).toBe(401);
      }
      expect((await login('member@test.local', PASSWORD, '192.0.2.20')).status).toBe(200);

      for (let i = 0; i < 4; i++) {
        expect((await login('member@test.local', 'wrong', `192.0.2.${i + 30}`)).status).toBe(401);
      }
    });

    it('stores a hash of the email, never the address itself', async () => {
      await login('private@test.local', 'wrong', '192.0.2.1');
      const rows = await getMiniflareRawDB()
        .prepare('SELECT ip FROM setup_attempt')
        .all<{ ip: string }>();
      const keys = rows.results.map((r) => r.ip);
      expect(keys).toContain('login-ip:192.0.2.1');
      expect(keys.some((k) => k.includes('private'))).toBe(false);
      expect(keys.some((k) => /^login-email:[0-9a-f]{64}$/.test(k))).toBe(true);
    });

    it('skips per-IP limiting when cf-connecting-ip is absent (local dev, tests)', async () => {
      await createLoginUser('local@test.local');
      for (let i = 0; i < 12; i++) {
        expect((await login(`nobody-${i}@test.local`, 'wrong')).status).toBe(401);
      }
      expect((await login('local@test.local', PASSWORD)).status).toBe(200);
    });

    it('fails open when the attempts table is unavailable', async () => {
      await createLoginUser('resilient@test.local');
      await getMiniflareRawDB().prepare('DROP TABLE setup_attempt').run();

      for (let i = 0; i < 12; i++) {
        expect((await login('resilient@test.local', 'wrong', '192.0.2.1')).status).toBe(401);
      }
      expect((await login('resilient@test.local', PASSWORD, '192.0.2.1')).status).toBe(200);
    });
  });

  describe('setup endpoints', () => {
    function setupPost(ip: string) {
      // No setup token: each attempt is rejected, but must still count.
      return app.request(
        '/api/setup',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
          body: JSON.stringify({}),
        },
        env(),
      );
    }

    function setupToken(ip: string) {
      return app.request('/api/setup/token', { headers: { 'cf-connecting-ip': ip } }, env());
    }

    it('rejects the 6th POST /api/setup from one IP within an hour', async () => {
      const ip = '203.0.113.20';
      for (let i = 0; i < 5; i++) {
        expect((await setupPost(ip)).status).toBe(401);
      }
      await expectTooMany(await setupPost(ip));
      expect((await setupPost('203.0.113.21')).status).toBe(401);
    });

    it('rejects the 21st GET /api/setup/token from one IP within an hour', async () => {
      const ip = '203.0.113.30';
      for (let i = 0; i < 20; i++) {
        expect((await setupToken(ip)).status).toBe(200);
      }
      await expectTooMany(await setupToken(ip));
      expect((await setupToken('203.0.113.31')).status).toBe(200);
    });

    it('keeps token and POST budgets separate', async () => {
      const ip = '203.0.113.40';
      for (let i = 0; i < 5; i++) await setupPost(ip);
      expect((await setupToken(ip)).status).toBe(200);
    });
  });

  describe('consumeRateLimit', () => {
    it('slides the window and reports when the oldest attempt expires', async () => {
      const db = getMiniflareRawDB();
      const rule = RATE_LIMITS.loginPerEmail;
      const start = Date.parse('2026-01-01T10:00:00.000Z');

      for (let i = 0; i < rule.limit; i++) {
        expect((await consumeRateLimit(db, rule, 'k', start + i * 1000)).allowed).toBe(true);
      }
      const blocked = await consumeRateLimit(db, rule, 'k', start + 60_000);
      expect(blocked).toEqual({ allowed: false, retryAfterSeconds: rule.windowMs / 1000 - 60 });

      // Once the first attempt leaves the window, one slot frees up.
      expect((await consumeRateLimit(db, rule, 'k', start + rule.windowMs + 1)).allowed).toBe(true);
      expect((await consumeRateLimit(db, rule, 'k', start + rule.windowMs + 2)).allowed).toBe(false);
    });

    it('allows everything when no database binding is present', async () => {
      for (let i = 0; i < 20; i++) {
        expect(await consumeRateLimit(undefined, RATE_LIMITS.loginPerIp, 'x')).toEqual({ allowed: true });
      }
    });
  });
});
