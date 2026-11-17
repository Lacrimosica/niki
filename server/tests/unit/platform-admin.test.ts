import { describe, it, expect } from 'vitest';
import { isPlatformAdmin } from '../../src/lib/deployment-mode';

describe('isPlatformAdmin', () => {
  it('matches trimmed entries case-insensitively', () => {
    expect(isPlatformAdmin(' a@x.local , Ops@Example.COM ', 'ops@example.com')).toBe(true);
    expect(isPlatformAdmin('ops@example.com', ' OPS@example.com ')).toBe(true);
  });

  it('rejects emails not in the list', () => {
    expect(isPlatformAdmin('ops@example.com', 'other@example.com')).toBe(false);
    expect(isPlatformAdmin('ops@example.com', 'ops@example.com.evil')).toBe(false);
  });

  it('fails closed when the list or email is missing or empty', () => {
    expect(isPlatformAdmin(undefined, 'ops@example.com')).toBe(false);
    expect(isPlatformAdmin('', 'ops@example.com')).toBe(false);
    expect(isPlatformAdmin(' , ,', 'ops@example.com')).toBe(false);
    expect(isPlatformAdmin('ops@example.com', '')).toBe(false);
    expect(isPlatformAdmin('ops@example.com', null)).toBe(false);
  });
});
