import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { unauthorized } from "../lib/errors.js";

export const SESSION_COOKIE = "bca_session";
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    user: SessionUser | null;
    sessionToken?: string;
  }
}

export async function createSession(userId: string, req: Request): Promise<string> {
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4, $5::inet)`,
    [sha256(token), userId, SESSION_TTL_MS, (req.get("user-agent") ?? "").slice(0, 300), req.ip && /^[0-9a-f:.]+$/i.test(req.ip) ? req.ip : null],
  );
  return token;
}

export const setSessionCookie = (res: Response, token: string) =>
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.appUrl.startsWith("https://"),
    maxAge: SESSION_TTL_MS,
    path: "/",
  });

export const clearSessionCookie = (res: Response) => res.clearCookie(SESSION_COOKIE, { path: "/" });

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export async function userForToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.is_platform_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, name: r.name, isPlatformAdmin: r.is_platform_admin } : null;
}

/** Attaches req.user (or null) from the session cookie. */
export async function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    req.sessionToken = readCookie(req, SESSION_COOKIE);
    req.user = await userForToken(req.sessionToken);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  next();
}

export async function destroySession(token: string) {
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

export async function destroyOtherSessions(userId: string, keepToken: string) {
  await pool.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, sha256(keepToken)]);
}
