-- Per-user voice tuning for spoken answers (ElevenLabs model, speed, stability, similarity).
ALTER TABLE user_preferences ADD COLUMN tts_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
