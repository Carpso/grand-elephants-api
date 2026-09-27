-- Migration 004: OTP lockout after repeated failed verifications.
-- Run once against the remote DB:
--   npx wrangler d1 execute grand-elephants-db --remote --file=./sql/migration_004.sql
-- (Safe to re-run: CREATE TABLE IF NOT EXISTS.)

CREATE TABLE IF NOT EXISTS otp_lockouts (
  phone TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL
);
