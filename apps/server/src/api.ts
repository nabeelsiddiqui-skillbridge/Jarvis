import { assertProductionConfig, config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";
import { syncPlatformAdmins } from "./auth/admins.js";

assertProductionConfig();
if (process.env.AUTO_MIGRATE !== "false") await migrate(config.databaseUrl, { quiet: true });
await syncPlatformAdmins();

createApp().listen(config.port, (err?: Error) => {
  // Express 5 passes listen errors (e.g. EADDRINUSE) to this callback.
  if (err) {
    console.error(`[api] failed to start: ${err.message}`);
    process.exit(1);
  }
  console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
});
