import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

/** An error whose message is safe to show to the user. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
export const unauthorized = (message = "Please sign in.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, "forbidden", message);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found.`);
export const conflict = (message: string) => new AppError(409, "conflict", message);
/** A prerequisite (configuration, connection, plan) is missing — the UI explains how to fix it. */
export const prerequisite = (message: string, details?: unknown) => new AppError(412, "prerequisite", message, details);

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return res.status(400).json({
      error: { code: "validation", message: `${where}${first?.message ?? "Invalid input"}`, details: err.issues.map((i) => ({ path: i.path, message: i.message })) },
    });
  }
  if ((err as any)?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "too_large", message: "Request is too large." } });
  }
  if ((err as any)?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "Malformed JSON." } });
  }
  // Never leak internals (SQL, stack, provider bodies) to the client.
  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[error ${ref}] ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: { code: "internal", message: `Something went wrong on our side (ref ${ref}).` } });
}
