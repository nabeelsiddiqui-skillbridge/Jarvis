import { hostname } from "node:os";
import { assertProductionConfig, config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { claim } from "./jobs/queue.js";
import { runJob } from "./jobs/handlers.js";
import { scheduleDueWork } from "./jobs/scheduler.js";
import { loadPlatformSecrets, watchPlatformSecrets } from "./lib/platformSecrets.js";

/**
 * Background worker: runs sync, webhook, health and (later) automation jobs from
 * the durable Postgres queue. Run as many instances as needed.
 */
assertProductionConfig();
if (process.env.AUTO_MIGRATE !== "false") await migrate(config.databaseUrl, { quiet: true });
// Provider credentials set in the admin console (refreshed so changes reach this process).
await loadPlatformSecrets();
watchPlatformSecrets();

const WORKER_ID = `${hostname()}:${process.pid}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);
let stopping = false;

async function loop(slot: number) {
  while (!stopping) {
    try {
      const job = await claim(`${WORKER_ID}#${slot}`);
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      await runJob(job);
    } catch (err) {
      console.error("[worker] loop error", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function schedulerLoop() {
  while (!stopping) {
    await scheduleDueWork().catch((e) => console.error("[worker] scheduler error", e));
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 10_000).unref(); });

console.log(`[worker] ${WORKER_ID} started with ${CONCURRENCY} slots`);
void schedulerLoop();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => loop(i)));
