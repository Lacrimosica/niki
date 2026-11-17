-- Index for the D1-backed rate limiter (src/lib/rate-limit.ts), which counts
-- rows per bucket key within a time window. Production already has this index
-- from 0060_setup_attempt.sql, but the consolidated dev baseline (0000) omitted
-- it. IF NOT EXISTS keeps this a no-op wherever it already exists.

CREATE INDEX IF NOT EXISTS idx_setup_attempt_ip_time ON setup_attempt(ip, attempted_at);
