import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** Stripe stand-in: records form-encoded requests and answers like the REST API. */
export interface StripeCall { method: string; path: string; form: Record<string, string>; idempotencyKey?: string; auth?: string }
export async function startMockStripe(port = 0) {
  const calls: StripeCall[] = [];
  const subscriptions = new Map<string, any>();
  let n = 0;
  const body = (req: IncomingMessage) => new Promise<string>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").replace(/^\/api\.stripe\.com\/v1\//, "");
    const form = Object.fromEntries(new URLSearchParams(await body(req)));
    calls.push({ method: req.method!, path, form, idempotencyKey: req.headers["idempotency-key"] as string | undefined, auth: req.headers.authorization });
    const json = (status: number, b: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.method === "POST" && path === "customers") return json(200, { id: `cus_${req.headers["idempotency-key"] ?? ++n}`.replace(/[^a-zA-Z0-9_]/g, "") });
    if (req.method === "POST" && path === "checkout/sessions") return json(200, { id: `cs_${++n}`, url: `https://checkout.stripe.test/c/${n}` });
    if (req.method === "POST" && path === "billing_portal/sessions") return json(200, { url: "https://billing.stripe.test/p/1" });
    const sub = path.match(/^subscriptions\/(.+)$/);
    if (req.method === "GET" && sub && subscriptions.has(sub[1]!)) return json(200, subscriptions.get(sub[1]!));
    json(404, { error: { message: "No such resource" } });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, subscriptions, close: () => new Promise<void>((r) => server.close(() => r())) };
}
