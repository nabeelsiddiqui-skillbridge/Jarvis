import { assertProductionConfig, config } from "./config.js";
import { migrate } from "./db/migrate.js";

assertProductionConfig();
if (process.env.AUTO_MIGRATE !== "false") await migrate(config.databaseUrl, { quiet: true });

// Job processing (sync jobs, webhooks, automations, retention) is added in Stage 3.
console.log("[worker] started");
setInterval(() => undefined, 60_000);
