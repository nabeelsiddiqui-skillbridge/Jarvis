import type { NextFunction, Request, Response } from "express";

/** Fixed-window in-memory limiter. Use a shared store (Redis/Postgres) when running several API instances. */
export function rateLimit({ max, windowMs, key = (req: Request) => req.ip ?? "unknown", name }: {
  max: number;
  windowMs: number;
  key?: (req: Request) => string;
  name: string;
}) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req: Request, res: Response, next: NextFunction) => {
    const k = `${name}:${key(req)}`;
    const now = Date.now();
    const entry = hits.get(k);
    if (!entry || entry.reset < now) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++entry.n > max) {
      res.setHeader("Retry-After", Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again." } });
    }
    next();
  };
}
