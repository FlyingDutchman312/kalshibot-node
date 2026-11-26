BEGIN;
ALTER TABLE public.kalshibot_official_outcomes
 ADD COLUMN IF NOT EXISTS mapping_verified boolean,
 ADD COLUMN IF NOT EXISTS mapping_version text,
 ADD COLUMN IF NOT EXISTS mapping_verified_at timestamptz;
COMMIT;
-- Existing rows intentionally remain unverified until checked against the official API.
