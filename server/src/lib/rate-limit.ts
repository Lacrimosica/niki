import type { Context } from 'hono';

/**
 * D1-backed sliding-window rate limiting for unauthenticated auth endpoints.
 *
 * Why D1 and not the Workers Rate Limiting binding: the binding only supports
 * 10s/60s periods and counts per colo (eventually consistent), so it cannot
 * express "5 failures per 15 minutes per account" and an attacker spreading
 * requests across locations multiplies the budget. These endpoints see little
 * legitimate traffic, so one D1 write per attempt is cheap, and a rejected
 * attempt writes nothing.
 *
 * Attempts live in the existing `setup_attempt` table (already deployed in
 * every environment with an (ip, attempted_at) index). Its `ip` column holds a
 * scoped bucket key such as `login-ip:203.0.113.7`, not necessarily a bare IP.
 */

export interface RateLimitRule {
  /** Bucket namespace, so different endpoints never share counters. */
  scope: string;
  limit: number;
  windowMs: number;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const RATE_LIMITS = {
  loginPerIp: { scope: 'login-ip', limit: 10, windowMs: MINUTE },
  loginPerEmail: { scope: 'login-email', limit: 5, windowMs: 15 * MINUTE },
  // The wizard fetches a token on every load and refreshes it every 29 minutes,
  // and a token alone grants nothing, so it gets more headroom than the POST.
  setupTokenPerIp: { scope: 'setup-token-ip', limit: 20, windowMs: HOUR },
  setupPerIp: { scope: 'setup-ip', limit: 5, windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

// Longest window above; rows older than this can no longer affect any decision.
const RETENTION_MS = HOUR;
// Pruning scans the whole table, so only a small share of requests pay for it.
const PRUNE_PROBABILITY = 0.02;

export const TOO_MANY_ATTEMPTS_MESSAGE = 'Troppi tentativi. Riprova più tardi.';

/**
 * Client IP as seen by Cloudflare. Deliberately ignores X-Forwarded-For, which
 * any client can set. Returns null off Cloudflare (local dev, tests), where
 * per-IP limiting is skipped rather than lumping every caller into one bucket.
 */
export function clientIp(c: Context): string | null {
  const ip = c.req.header('cf-connecting-ip')?.trim();
  return ip ? ip : null;
}

/** Hashes an email so the attempts table never stores addresses in clear. */
export async function emailBucketId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function bucketKey(rule: RateLimitRule, id: string): string {
  return `${rule.scope}:${id}`;
}

/**
 * Records one attempt against the bucket unless it is already full.
 *
 * The count and the insert run as a single statement, so concurrent requests
 * cannot both slip past the limit. Fails open: a missing binding or a DB error
 * must never lock everyone out of login.
 */
export async function consumeRateLimit(
  db: D1Database | undefined,
  rule: RateLimitRule,
  id: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  if (!db) return { allowed: true };

  const key = bucketKey(rule, id);
  const windowStart = new Date(now - rule.windowMs).toISOString();

  try {
    const inserted = await db
      .prepare(
        `INSERT INTO setup_attempt (id, ip, attempted_at)
         SELECT ?1, ?2, ?3
         WHERE (SELECT COUNT(*) FROM setup_attempt WHERE ip = ?2 AND attempted_at >= ?4) < ?5`,
      )
      .bind(crypto.randomUUID(), key, new Date(now).toISOString(), windowStart, rule.limit)
      .run();

    if (Math.random() < PRUNE_PROBABILITY) {
      await pruneExpiredAttempts(db, now);
    }

    if ((inserted.meta.changes ?? 0) > 0) return { allowed: true };

    // Sliding window: the caller may retry once the oldest counted attempt expires.
    const oldest = await db
      .prepare('SELECT MIN(attempted_at) AS oldest FROM setup_attempt WHERE ip = ?1 AND attempted_at >= ?2')
      .bind(key, windowStart)
      .first<{ oldest: string | null }>();
    const oldestMs = oldest?.oldest ? Date.parse(oldest.oldest) : now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestMs + rule.windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  } catch (err) {
    console.error(`Rate limit check failed for scope ${rule.scope}; allowing request:`, err);
    return { allowed: true };
  }
}

/** Clears a bucket, e.g. an account's failure count after a successful login. */
export async function resetRateLimit(
  db: D1Database | undefined,
  rule: RateLimitRule,
  id: string,
): Promise<void> {
  if (!db) return;
  try {
    await db.prepare('DELETE FROM setup_attempt WHERE ip = ?1').bind(bucketKey(rule, id)).run();
  } catch (err) {
    console.error(`Rate limit reset failed for scope ${rule.scope}:`, err);
  }
}

async function pruneExpiredAttempts(db: D1Database, now: number): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM setup_attempt WHERE attempted_at < ?1')
      .bind(new Date(now - RETENTION_MS).toISOString())
      .run();
  } catch (err) {
    console.error('Pruning expired rate limit attempts failed:', err);
  }
}

/** Generic 429 response; the body never reveals which bucket was exhausted. */
export function tooManyAttempts(c: Context, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json({ error: TOO_MANY_ATTEMPTS_MESSAGE }, 429);
}
