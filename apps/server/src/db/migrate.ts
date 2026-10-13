import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

/** Locate db/migrations whether running from src (tsx) or dist (bundled). */
function migrationsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(here, "../../../../db/migrations"),
    path.resolve(here, "../../../db/migrations"),
    path.resolve(process.cwd(), "db/migrations"),
    path.resolve(process.cwd(), "../../db/migrations"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (readdirSync(c).some((f) => f.endsWith(".sql"))) return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not find db/migrations");
}

/** Creates the database if it doesn't exist (handy for local dev). */
async function ensureDatabase(url: string) {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (!rowCount) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
      console.log(`[migrate] created database ${dbName}`);
    }
  } catch (err) {
    // Managed Postgres often forbids connecting to "postgres"; the target DB must then already exist.
    if (process.env.DEBUG) console.warn("[migrate] ensureDatabase skipped:", (err as Error).message);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function migrate(url = config.databaseUrl, { quiet = false } = {}) {
  await ensureDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialise concurrent migrators (e.g. api + worker booting together).
    await client.query("SELECT pg_advisory_lock(727274)");
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        if (!quiet) console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    await client.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then(() => console.log("[migrate] up to date"))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
