-- Provider credentials managed from the admin console (encrypted with ENCRYPTION_KEY),
-- and each user's chosen assistant voice.

CREATE TABLE platform_secrets (
  key        text PRIMARY KEY,
  value_enc  text NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Only the server's owner role reads this table; the request role has no grant and RLS denies all.
ALTER TABLE platform_secrets ENABLE ROW LEVEL SECURITY;

ALTER TABLE user_preferences ADD COLUMN tts_voice text;
