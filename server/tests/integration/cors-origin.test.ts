import { describe, it, expect } from 'vitest';
import app from '../../src/index';

/** CORS preflights are answered by the middleware before auth or DB access. */
async function preflight(origin: string, corsOrigin?: string) {
  return app.request(
    '/api/people',
    {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    },
    { JWT_SECRET: 'unused', ...(corsOrigin === undefined ? {} : { CORS_ORIGIN: corsOrigin }) },
  );
}

describe('CORS origin policy', () => {
  describe('without CORS_ORIGIN', () => {
    it('allows localhost origins', async () => {
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8787', 'http://localhost']) {
        const res = await preflight(origin);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
        expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      }
    });

    it('does not allow other origins or a wildcard', async () => {
      for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'https://localhost:5173']) {
        const res = await preflight(origin);
        const allowed = res.headers.get('Access-Control-Allow-Origin');
        expect(allowed).not.toBe(origin);
        expect(allowed).not.toBe('*');
      }
    });
  });

  describe('with CORS_ORIGIN', () => {
    it('allows only the configured origin', async () => {
      const ok = await preflight('https://app.example', 'https://app.example');
      expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');

      const local = await preflight('http://localhost:5173', 'https://app.example');
      expect(local.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('supports a comma-separated list', async () => {
      const list = 'https://app.example, https://demo.example/';
      for (const origin of ['https://app.example', 'https://demo.example']) {
        const res = await preflight(origin, list);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      }
      const other = await preflight('https://evil.example', list);
      expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
