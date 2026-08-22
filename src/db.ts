import { SQL } from "bun";

export type IConfig = {
  guild_id: string;
  report_channel_id: string | null;
  anonymous_enabled: boolean;
  urgent_role_id: string | null;
};

export const db = new SQL(process.env.DATABASE_URL ?? "sqlite://report-bot.sqlite");

export async function initDb() {
  if (db.options.adapter === "sqlite") {
    try {
      await db`PRAGMA foreign_keys = ON;`;
      await db`PRAGMA journal_mode = WAL;`;
      await db`PRAGMA busy_timeout = 5000;`;
      await db`PRAGMA wal_autocheckpoint = 1000;`;
      await db`PRAGMA synchronous = NORMAL;`;
    } catch (err) {
      console.error("Failed to set PRAGMA settings:", err);
    }
  }

  await db`
    CREATE TABLE IF NOT EXISTS config (
      guild_id TEXT PRIMARY KEY,
      report_channel_id TEXT,
      anonymous_enabled INTEGER NOT NULL DEFAULT 0,
      urgent_role_id TEXT
    );
  `;
}

export async function removeGuild(guild_id: string): Promise<void> {
  await db`DELETE FROM config WHERE guild_id = ${guild_id}`;
}

export async function ensureConfig(guild_id: string): Promise<void> {
  await db`
    INSERT INTO config (guild_id) VALUES (${guild_id})
    ON CONFLICT(guild_id) DO NOTHING;
  `;
}

export async function getConfig(guild_id: string): Promise<IConfig> {
  const [row] = await db`SELECT * FROM config WHERE guild_id = ${guild_id}`;
  return {
    guild_id,
    report_channel_id: row?.report_channel_id ?? null,
    anonymous_enabled: !!row?.anonymous_enabled,
    urgent_role_id: row?.urgent_role_id ?? null,
  };
}

export async function setConfig(guild_id: string, { report_channel_id, anonymous_enabled, urgent_role_id }: Omit<IConfig, "guild_id">): Promise<void> {
  await ensureConfig(guild_id);
  await db`
    UPDATE config SET
      report_channel_id = ${report_channel_id},
      anonymous_enabled = ${anonymous_enabled ? 1 : 0},
      urgent_role_id = ${urgent_role_id}
    WHERE guild_id = ${guild_id};
  `;
}
