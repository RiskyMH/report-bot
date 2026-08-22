import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

// dedicated throwaway-ish cache db: survives restarts but isn't precious
const reportCachePath = process.env.REPORT_CACHE_DB ?? "report-cache.sqlite";
mkdirSync(dirname(reportCachePath), { recursive: true });
export const reportDb = new Database(reportCachePath);

reportDb.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS message_reports (
        key TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        source_channel_name TEXT,
        msg_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        username TEXT,
        forwarded INTEGER,
        app_command INTEGER,
        content TEXT,
        images TEXT,
        files TEXT,
        urgent INTEGER,
        log_channel_id TEXT NOT NULL,
        log_message_id TEXT,
        last_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_reports (
        key TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        global_name TEXT,
        nick TEXT,
        account_at INTEGER NOT NULL,
        joined_at INTEGER,
        avatar TEXT,
        server_avatar TEXT,
        banner TEXT,
        server_banner TEXT,
        log_channel_id TEXT NOT NULL,
        log_message_id TEXT,
        urgent INTEGER,
        last_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_reporters (
        target_key TEXT NOT NULL REFERENCES message_reports(key) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        context TEXT,
        PRIMARY KEY (target_key, reported_at, user_id)
    );
    CREATE TABLE IF NOT EXISTS user_reporters (
        target_key TEXT NOT NULL REFERENCES user_reports(key) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        context TEXT,
        PRIMARY KEY (target_key, reported_at, user_id)
    );
`);

export type StoredReporter = { u: string; t: number; c: string | null };
export type StoredAttachment = { n: string; u: string; s: number; ct: string | null };

export type MessageReportRow = {
    key: string;
    guild_id: string;
    source_channel_id: string;
    source_channel_name: string | null;
    msg_id: string;
    author_id: string;
    username: string | null;
    forwarded: boolean;
    app_command: boolean;
    content: string | null;
    images: StoredAttachment[];
    files: StoredAttachment[];
    urgent: boolean;
    log_channel_id: string;
    log_message_id: string | null;
    reporters?: StoredReporter[];
    last_at: number;
};

export type UserReportRow = {
    key: string;
    guild_id: string;
    user_id: string;
    username: string;
    global_name: string | null;
    nick: string | null;
    account_at: number;
    joined_at: number | null;
    avatar: string | null;
    server_avatar: string | null;
    banner: string | null;
    server_banner: string | null;
    log_channel_id: string;
    log_message_id: string | null;
    urgent: boolean;
    reporters?: StoredReporter[];
    last_at: number;
};

export function getReporters(kind: "m" | "u", targetKey: string): StoredReporter[] {
    const rows = (kind === "m"
        ? reportDb.query("SELECT user_id, reported_at, context FROM message_reporters WHERE target_key = ? ORDER BY reported_at").all(targetKey)
        : reportDb.query("SELECT user_id, reported_at, context FROM user_reporters WHERE target_key = ? ORDER BY reported_at").all(targetKey)) as any[];
    return rows.map(r => ({ u: r.user_id, t: r.reported_at, c: r.context ?? null }));
}

export function appendReporter(kind: "m" | "u", targetKey: string, reporter: StoredReporter): void {
    if (kind === "m") {
        // same user submitting twice in the same second overwrites their earlier context
        reportDb.query(`
            INSERT INTO message_reporters (target_key, user_id, reported_at, context) VALUES (?, ?, ?, ?)
            ON CONFLICT(target_key, reported_at, user_id) DO UPDATE SET context = excluded.context
        `).run(targetKey, reporter.u, reporter.t, reporter.c);
    } else {
        reportDb.query(`
            INSERT INTO user_reporters (target_key, user_id, reported_at, context) VALUES (?, ?, ?, ?)
            ON CONFLICT(target_key, reported_at, user_id) DO UPDATE SET context = excluded.context
        `).run(targetKey, reporter.u, reporter.t, reporter.c);
    }
}

export function getMessageReport(key: string): MessageReportRow | null {
    const row = reportDb.query("SELECT * FROM message_reports WHERE key = ?").get(key) as any;
    if (!row) return null;
    return {
        ...row,
        forwarded: !!row.forwarded,
        app_command: !!row.app_command,
        urgent: !!row.urgent,
        images: parseJsonArray(row.images),
        files: parseJsonArray(row.files),
        reporters: getReporters("m", key),
    };
}

export function setMessageReport(row: Omit<MessageReportRow, "reporters">): void {
    reportDb.query(`
        INSERT INTO message_reports (key, guild_id, source_channel_id, source_channel_name, msg_id, author_id, username, forwarded, app_command, content, images, files, urgent, log_channel_id, log_message_id, last_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            source_channel_name = excluded.source_channel_name,
            author_id = excluded.author_id,
            username = excluded.username,
            forwarded = excluded.forwarded,
            app_command = excluded.app_command,
            content = excluded.content,
            images = excluded.images,
            files = excluded.files,
            urgent = MAX(message_reports.urgent, excluded.urgent),
            log_channel_id = excluded.log_channel_id,
            log_message_id = COALESCE(message_reports.log_message_id, excluded.log_message_id),
            last_at = excluded.last_at
    `).run(
        row.key, row.guild_id, row.source_channel_id, row.source_channel_name, row.msg_id, row.author_id, row.username,
        row.forwarded ? 1 : 0, row.app_command ? 1 : 0, row.content, JSON.stringify(row.images), JSON.stringify(row.files),
        row.urgent ? 1 : 0, row.log_channel_id, row.log_message_id, row.last_at,
    );
}

export function getUserReport(key: string): UserReportRow | null {
    const row = reportDb.query("SELECT * FROM user_reports WHERE key = ?").get(key) as any;
    if (!row) return null;
    return {
        ...row,
        urgent: !!row.urgent,
        reporters: getReporters("u", key),
    };
}

export function setUserReport(row: Omit<UserReportRow, "reporters">): void {
    reportDb.query(`
        INSERT INTO user_reports (key, guild_id, user_id, username, global_name, nick, account_at, joined_at, avatar, server_avatar, banner, server_banner, log_channel_id, log_message_id, urgent, last_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            username = excluded.username,
            global_name = excluded.global_name,
            nick = excluded.nick,
            joined_at = COALESCE(user_reports.joined_at, excluded.joined_at),
            avatar = COALESCE(user_reports.avatar, excluded.avatar),
            server_avatar = COALESCE(user_reports.server_avatar, excluded.server_avatar),
            banner = COALESCE(user_reports.banner, excluded.banner),
            server_banner = COALESCE(user_reports.server_banner, excluded.server_banner),
            log_channel_id = excluded.log_channel_id,
            log_message_id = COALESCE(user_reports.log_message_id, excluded.log_message_id),
            urgent = MAX(user_reports.urgent, excluded.urgent),
            last_at = excluded.last_at
    `).run(
        row.key, row.guild_id, row.user_id, row.username, row.global_name, row.nick,
        row.account_at, row.joined_at, row.avatar, row.server_avatar,
        row.banner, row.server_banner, row.log_channel_id, row.log_message_id,
        row.urgent ? 1 : 0, row.last_at,
    );
}

export function markReportUrgent(kind: "m" | "u", key: string): void {
    const table = kind === "m" ? "message_reports" : "user_reports";
    reportDb.query(`UPDATE ${table} SET urgent = 1 WHERE key = ? AND NOT urgent`).run(key);
}

export function setReportLogTarget(kind: "m" | "u", key: string, logChannelId: string, logMessageId: string | null): void {
    const table = kind === "m" ? "message_reports" : "user_reports";
    reportDb.query(`UPDATE ${table} SET log_channel_id = ?, log_message_id = ?, last_at = ? WHERE key = ?`)
        .run(logChannelId, logMessageId, Date.now(), key);
}

export function clearGuildReports(guildId: string): void {
    reportDb.query("DELETE FROM message_reports WHERE guild_id = ?").run(guildId);
    reportDb.query("DELETE FROM user_reports WHERE guild_id = ?").run(guildId);
}

export function pruneStaleReports(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    // children clean themselves up via ON DELETE CASCADE
    return (
        reportDb.query("DELETE FROM message_reports WHERE last_at < ?").run(cutoff).changes +
        reportDb.query("DELETE FROM user_reports WHERE last_at < ?").run(cutoff).changes
    );
}

function parseJsonArray<T>(json: string | null): T[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}
