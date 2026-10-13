import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

function loadKey(): Buffer {
  if (config.encryptionKey) return createHash("sha256").update(config.encryptionKey).digest();
  if (config.isProd) throw new Error("ENCRYPTION_KEY must be set in production.");
  // Development only: persist a generated key so tokens survive restarts.
  const dir = path.resolve(process.env.DEV_DATA_DIR ?? ".data");
  const file = path.join(dir, "dev-encryption.key");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    console.warn(`[crypto] ENCRYPTION_KEY not set — generated a development key at ${file}`);
  }
  return createHash("sha256").update(readFileSync(file, "utf8").trim()).digest();
}

let key: Buffer | null = null;
const getKey = () => (key ??= loadKey());

/** AES-256-GCM. Output: "v1:" + base64(iv | tag | ciphertext). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;
}

export function decryptJson<T>(blob: string): T {
  if (!blob.startsWith("v1:")) throw new Error("Unsupported ciphertext");
  const raw = Buffer.from(blob.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string | Buffer, b: string | Buffer) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Stable JSON (sorted keys) — used to hash action payloads for approval binding. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}
