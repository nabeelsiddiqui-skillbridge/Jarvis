// Starts the Shopify stand-in on a fixed port for manual/browser testing.
import { startMockShopify } from "./mock-shopify.js";
const m = await startMockShopify();
console.log(`[mock-shopify] ${m.url}`);
