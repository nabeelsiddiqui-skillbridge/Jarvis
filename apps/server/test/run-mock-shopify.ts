// Starts the Shopify stand-in on a fixed port for manual/browser testing.
import { startMockShopify } from "./mock-shopify.js";
const m = await startMockShopify();
console.log(`[mock-shopify] ${m.url}`);
// Pre-accepted custom-app tokens (comma-separated), for trying "connect with an access token".
for (const t of (process.env.MOCK_SHOPIFY_TOKENS ?? "").split(",").filter(Boolean)) m.state.tokens.add(t);
