import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Credentials } from "./connectors/types.js";
import { db, decrypt, encrypt } from "./db.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// ------------------------------------------------------------------ users + passwords

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

const toUser = (r: any): User => ({ id: r.id, email: r.email, name: r.name, createdAt: r.created_at });

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Compared against when the email doesn't exist, so response time doesn't reveal which emails are registered.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));

export async function createUser(email: string, name: string, password: string): Promise<User> {
  const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
  if (exists) throw new Error("An account with that email already exists.");
  const user = { id: randomUUID(), email, name, createdAt: Date.now() };
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    user.id, user.email, user.name, await hashPassword(password), user.createdAt,
  );
  return user;
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const row: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const ok = await checkPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? toUser(row) : null;
}

export async function changePassword(userId: string, current: string, next: string): Promise<boolean> {
  const row: any = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId);
  if (!row || !(await checkPassword(current, row.password_hash))) return false;
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(next), userId);
  return true;
}

export function deleteUser(userId: string) {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId); // cascades to sessions, accounts, dashboards
}

// ------------------------------------------------------------------ sessions

export const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, Date.now() + SESSION_TTL);
  return token;
}

export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const row: any = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
    .get(sha(token), Date.now());
  return row ? toUser(row) : null;
}

export function deleteSession(token: string) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

export function deleteOtherSessions(userId: string, keepToken: string) {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, sha(keepToken));
}

setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()), 60 * 60 * 1000).unref();

// ------------------------------------------------------------------ connected accounts

/**
 * A connected account. Credentials are encrypted at rest and never sent to the
 * browser — the client only ever sees `provider`, `demo` and `connectedAt`.
 */
export interface Account {
  userId: string;
  provider: string;
  creds: Credentials;
  demo: boolean;
  connectedAt: number;
}

const toAccount = (r: any): Account => ({
  userId: r.user_id,
  provider: r.provider,
  creds: decrypt<Credentials>(r.creds_enc),
  demo: Boolean(r.demo),
  connectedAt: r.connected_at,
});

export function listAccounts(userId: string): Map<string, Account> {
  const rows = db.prepare("SELECT * FROM accounts WHERE user_id = ? ORDER BY connected_at").all(userId);
  return new Map(rows.map((r) => [String(r.provider), toAccount(r)]));
}

export function getAccount(userId: string, provider: string): Account | undefined {
  const row = db.prepare("SELECT * FROM accounts WHERE user_id = ? AND provider = ?").get(userId, provider);
  return row ? toAccount(row) : undefined;
}

export function saveAccount(a: Account) {
  db.prepare(
    `INSERT INTO accounts (user_id, provider, demo, creds_enc, connected_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET demo = excluded.demo, creds_enc = excluded.creds_enc, connected_at = excluded.connected_at`,
  ).run(a.userId, a.provider, a.demo ? 1 : 0, encrypt(a.creds), a.connectedAt);
}

/** Persist refreshed credentials (e.g. a new OAuth access token) without touching anything else. */
export function updateCreds(a: Account) {
  db.prepare("UPDATE accounts SET creds_enc = ? WHERE user_id = ? AND provider = ?").run(encrypt(a.creds), a.userId, a.provider);
}

export function deleteAccount(userId: string, provider: string) {
  db.prepare("DELETE FROM accounts WHERE user_id = ? AND provider = ?").run(userId, provider);
}

export function publicAccount(a: Account) {
  return { provider: a.provider, demo: a.demo, connectedAt: a.connectedAt };
}

// ------------------------------------------------------------------ dashboards

export function getDashboards(userId: string): unknown | null {
  const row: any = db.prepare("SELECT state FROM dashboards WHERE user_id = ?").get(userId);
  return row ? JSON.parse(row.state) : null;
}

export function saveDashboards(userId: string, state: unknown) {
  db.prepare(
    `INSERT INTO dashboards (user_id, state, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(userId, JSON.stringify(state), Date.now());
}
