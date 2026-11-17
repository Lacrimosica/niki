const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Decide which request origin to echo in Access-Control-Allow-Origin.
 *
 * Responses are sent with credentials allowed, so a wildcard or a reflected
 * arbitrary origin would let any site make authenticated calls. When
 * CORS_ORIGIN is unset we therefore fail closed to local development origins
 * instead of '*'.
 *
 * @param configured comma-separated list of allowed origins (CORS_ORIGIN)
 * @returns the origin to allow, or null to omit the header
 */
export function resolveCorsOrigin(requestOrigin: string, configured: string | undefined): string | null {
  if (!requestOrigin) return null;

  const allowed = (configured ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (allowed.length === 0) {
    return LOCAL_ORIGIN.test(requestOrigin) ? requestOrigin : null;
  }
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}
