import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/**
 * Binds an OAuth `state` to the browser that started the flow.
 *
 * A signed state proves the server issued it, not that the browser returning it is
 * the one that asked for it. Without this binding an attacker can finish a Google
 * flow with their own account and hand the callback URL to a victim (login CSRF).
 *
 * The start endpoint stores a random nonce in an HttpOnly cookie on the API origin
 * and puts its hash in the state; the callback requires the cookie to match. Both
 * requests are top-level navigations to the API origin, so a SameSite=Lax cookie
 * is sent on the cross-site redirect back from accounts.google.com.
 */

export type OAuthFlow = 'login' | 'drive';

const NONCE_TTL_SECONDS = 600;
// Covers /api/auth/google/callback and /api/auth/google/drive/callback.
const COOKIE_PATH = '/api/auth/google';

const cookieName = (flow: OAuthFlow) => `oauth_nonce_${flow}`;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce));
  return base64Url(new Uint8Array(digest));
}

/** Set the nonce cookie and return the hash to embed in the state. */
export async function startOAuthBinding(c: Context, flow: OAuthFlow): Promise<string> {
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  setCookie(c, cookieName(flow), nonce, {
    httpOnly: true,
    // Plain-http local dev (wrangler on localhost) would drop a Secure cookie in some browsers.
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: COOKIE_PATH,
    maxAge: NONCE_TTL_SECONDS,
  });
  return hashNonce(nonce);
}

/**
 * Check the callback's browser holds the nonce whose hash is in the state.
 * The cookie is cleared either way so a state can only be completed once per start.
 */
export async function verifyOAuthBinding(c: Context, flow: OAuthFlow, nonceHash: unknown): Promise<boolean> {
  const nonce = getCookie(c, cookieName(flow));
  deleteCookie(c, cookieName(flow), { path: COOKIE_PATH });
  if (!nonce || typeof nonceHash !== 'string') return false;
  const actual = await hashNonce(nonce);
  // Both sides are fixed-length hashes; compare without early exit anyway.
  if (actual.length !== nonceHash.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ nonceHash.charCodeAt(i);
  return diff === 0;
}
