// Starts the ElevenLabs stand-in on a fixed port for manual/browser testing.
import { startMockElevenLabs } from "./mock-elevenlabs.js";
const m = await startMockElevenLabs(process.env.ELEVENLABS_API_KEY ?? "xi-local-key", Number(process.env.MOCK_ELEVENLABS_PORT ?? 8893));
console.log(`[mock-elevenlabs] ${m.url}`);
