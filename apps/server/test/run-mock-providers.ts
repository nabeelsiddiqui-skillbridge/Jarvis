// Starts the Google and HubSpot stand-ins on fixed ports for manual/browser testing.
import { startMockGoogle, startMockHubSpot } from "./mock-providers.js";
const g = await startMockGoogle(Number(process.env.MOCK_GOOGLE_PORT ?? 8898));
const h = await startMockHubSpot(Number(process.env.MOCK_HUBSPOT_PORT ?? 8897));
console.log(`[mock-google] ${g.url}\n[mock-hubspot] ${h.url}`);
