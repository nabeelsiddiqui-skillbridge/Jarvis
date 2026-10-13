// Starts the Stripe stand-in on a fixed port for manual/browser testing.
import { startMockStripe } from "./mock-stripe.js";
const s = await startMockStripe(Number(process.env.MOCK_STRIPE_PORT ?? 8894));
console.log(`[mock-stripe] ${s.url}`);
