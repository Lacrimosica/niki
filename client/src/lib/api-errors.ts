import axios from 'axios';
import type { TFunction } from 'i18next';

/** Machine-readable code the server returns with HTTP 429 on auth endpoints. */
export const TOO_MANY_REQUESTS_CODE = 'too_many_requests';

/**
 * Message to show for a failed auth/setup request. Rate-limit responses carry
 * only a code, so they are translated here; other server errors keep their text.
 */
export function apiErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  if (!axios.isAxiosError(err)) return fallback;
  const serverError: unknown = err.response?.data?.error;
  if (err.response?.status === 429 || serverError === TOO_MANY_REQUESTS_CODE) {
    return t('auth.tooManyRequests');
  }
  return typeof serverError === 'string' && serverError ? serverError : fallback;
}
