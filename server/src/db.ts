import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const DATA_DIR = path.resolve(
  process.env.JARVIS_DATA_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../data"),
);
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.JARVIS_DB ?? path.join(DATA_DIR, "jarvis.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- Only a SHA-256 of the session token is stored, so a leaked DB can't be used to log in.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  -- Connected accounts. creds_enc is AES-256-GCM ciphertext of the credential JSON.
  CREATE TABLE IF NOT EXISTS accounts (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,
    demo         INTEGER NOT NULL,
    creds_enc    TEXT NOT NULL,
    connected_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider)
  );

  CREATE TABLE IF NOT EXISTS dashboards (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ------------------------------------------------------------------ encryption key

function loadKey(): Buffer {
  const fromEnv = process.env.JARVIS_SECRET?.trim();
  if (fromEnv) return createHash("sha256").update(fromEnv).digest();

  if (process.env.NODE_ENV === "production") {
    throw new Error("JARVIS_SECRET must be set in production — it encrypts every stored credential.");
  }
  // Development convenience: generate a key once and keep it next to the database.
  const file = path.join(DATA_DIR, "secret.key");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    console.warn(`[jarvis] No JARVIS_SECRET set — generated a dev key at ${file}. Set JARVIS_SECRET in production.`);
  }
  chmodSync(file, 0o600);
  return createHash("sha256").update(readFileSync(file, "utf8").trim()).digest();
}

const KEY = loadKey();

export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decrypt<T>(blob: string): T {
  if (!blob.startsWith("v1:")) throw new Error("Unknown ciphertext version");
  const raw = Buffer.from(blob.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
}
