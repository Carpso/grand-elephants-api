-- Migration: rider proof-of-delivery photo (idempotent, non-destructive).
-- Run once against the remote DB:
--   npx wrangler d1 execute grand-elephants-db --remote --file=./sql/migration_002.sql
-- (Fails harmlessly with "duplicate column name: proof_photo" if already applied.)
ALTER TABLE orders ADD COLUMN proof_photo TEXT;
