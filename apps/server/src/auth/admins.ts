import { config } from "../config.js";
import { pool } from "../db/pool.js";

/**
 * Accounts listed in PLATFORM_ADMIN_EMAILS are platform administrators. Applied at
 * boot (and at sign-up) so the list in configuration is the source of truth:
 * removing an email removes the access on the next restart.
 */
export async function syncPlatformAdmins() {
  await pool.query(`UPDATE users SET is_platform_admin = (lower(email::text) = ANY($1::text[])) WHERE is_platform_admin <> (lower(email::text) = ANY($1::text[]))`, [config.platformAdmins]);
}
