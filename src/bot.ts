import { Client } from "@discordjs/core";
import { DiscordAPIError, REST, type RawFile } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import {
    ButtonStyle,
    ChannelType,
    ComponentType,
    GatewayDispatchEvents,
    GatewayIntentBits,
    InteractionType,
    MessageFlags,
    PermissionFlagsBits,
    RESTJSONErrorCodes,
    Routes,
    SelectMenuDefaultValueType,
    TextInputStyle,
    type APIAttachment,
    type APIInteractionDataResolved,
    type APIMessage,
    type APIMessageSnapshotFields,
    type APIModalInteractionResponseCallbackData,
    type APIModalSubmitInteraction,
    type APIUser,
    type RESTGetAPIGatewayBotResult,
    type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import * as db from "./db";
import { commands } from "./commands";
import * as cache from "./report-cache";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN environment variable not set.");

process.title = "Report Bot";


process.on('uncaughtException', (err) => {
    console.error(`Unhandled Exception: ${err}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

const rest = new REST({ version: "10" }).setToken(token);
const gateway = new WebSocketManager({
    token,
    intents: GatewayIntentBits.Guilds,
    fetchGatewayInformation: () => rest.get(Routes.gatewayBot()) as Promise<RESTGetAPIGatewayBotResult>,
    shardCount: null,
});

const client = new Client({ rest, gateway });

const commandIds = {} as Record<string, string>;
client.once(GatewayDispatchEvents.Ready, async (c) => {
    console.log(`${c.data.user.username} is ready!`);

    const commandsRes = await c.api.applicationCommands.bulkOverwriteGlobalCommands(c.data.user.id, commands);
    for (const cmd of commandsRes) commandIds[cmd.name] = cmd.id;
});

client.on(GatewayDispatchEvents.GuildDelete, async ({ data: guild }) => {
    if (!guild.id || guild.unavailable) return;
    await db.removeGuild(guild.id);
    cache.clearGuildReports(guild.id);
});


const GROUP_FRESH_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// keep the cache db from ballooning with dead sessions
setInterval(() => {
    try {
        const pruned = cache.pruneStaleReports(GROUP_FRESH_MS);
        if (pruned > 0) console.log(`Pruned ${pruned} stale report session(s)`);
    } catch (err) {
        console.error(`Failed pruning report cache: ${err}`);
    }
}, 60_000).unref();

const quote = (text: string) =>
    text.split("\n").map(l => `> ${l}`).join("\n");
const snowflakeDate = (id: string) => Math.floor(Number(BigInt(id) >> 22n) / 1000 + 1420070400);

// keeps raw filenames; only prefixes an index when a name collides within the batch
function uniqueFileNames(atts: { filename?: string }[]): string[] {
    const used = new Set<string>();
    return atts.map(a => {
        const base = (a.filename ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-64) || "file";
        let name = base;
        let i = 1;
        while (used.has(name)) name = `${i++}_${base}`;
        used.add(name);
        return name;
    });
}

const truncate = (text: string, max: number) =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// forum posts require a thread name (1-100 chars); starter message keeps the usual components
function forumThreadName(base: string): string {
    const name = base.trim() || "Report";
    return truncate(name, 100);
}

function isSmall(a: cache.StoredAttachment): boolean {
    return a.s > 0 && a.s <= MAX_UPLOAD_BYTES;
}

// downloads the small ones for self-hosting; failures demote to link-only
async function downloadSmall(atts: cache.StoredAttachment[]): Promise<RawFile[]> {
    const out: RawFile[] = [];
    for (const a of atts) {
        try {
            const res = await fetch(a.u, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(String(res.status));
            const buf = await res.arrayBuffer();
            out.push({ data: new Uint8Array(buf), name: a.n, contentType: a.ct ?? undefined });
        } catch {
            a.s = -1; // too big / unreachable -> render as masked link instead
        }
    }
    return out;
}

function snapshotOf(msg: APIMessage): APIMessageSnapshotFields | null {
    return msg.message_snapshots?.[0]?.message ?? null;
}

function messageContentComponents(row: cache.MessageReportRow): NonNullable<RESTPostAPIChannelMessageJSONBody["components"]> {
    const jumpUrl = `https://discord.com/channels/${row.guild_id}/${row.source_channel_id}/${row.msg_id}`;
    const smallImages = row.images.filter(isSmall);
    const smallFiles = row.files.filter(isSmall);
    const bigOnes = [...row.images, ...row.files].filter(a => !isSmall(a));
    return [
        {
            type: ComponentType.TextDisplay,
            content: [
                `### Reported message by @${row.username || "unknown"}`,
                ...(row.content ? [quote(row.content).slice(0, 2000)] : ["-# *(no text content)*"]),
            ].join("\n"),
        },
        ...(smallImages.length > 0 ? [{
            type: ComponentType.MediaGallery,
            items: smallImages.map(a => ({ media: { url: `attachment://${a.n}` } })),
        }] : []),
        ...(smallFiles.length > 0 ? smallFiles.map(a => ({
            type: ComponentType.File,
            file: { url: `attachment://${a.n}` },
        })) : []),
        {
            type: ComponentType.TextDisplay,
            content: [
                `**By:** <@${row.author_id}> • <t:${snowflakeDate(row.msg_id)}:f>${row.forwarded ? " • forwarded" : ""}${row.app_command ? " • app command" : ""}`,
                ...(bigOnes.length > 0 ? [`-# too large to rehost: ${bigOnes.map(a => `[${a.n}](${a.u})`).join(" | ")}`] : []),
            ].join("\n"),
        },
        {
            type: ComponentType.ActionRow,
            components: [{
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: truncate(`Jump to Message${row.source_channel_name ? ` in #${row.source_channel_name}` : ""}`, 80),
                url: jumpUrl,
            }],
        },
    ] as NonNullable<RESTPostAPIChannelMessageJSONBody["components"]>;
}

function userContentComponents(row: cache.UserReportRow): NonNullable<RESTPostAPIChannelMessageJSONBody["components"]> {
    const links: string[] = [];
    if (row.avatar) links.push(`[pfp](${cdn.avatar(row.user_id, row.avatar)})`);
    if (row.server_avatar) links.push(`[server pfp](${cdn.guildAvatar(row.guild_id, row.user_id, row.server_avatar)})`);
    if (row.banner) links.push(`[banner](${cdn.banner(row.user_id, row.banner)})`);
    if (row.server_banner) links.push(`[server banner](${cdn.guildBanner(row.guild_id, row.user_id, row.server_banner)})`);

    return [
        {
            type: ComponentType.Section,
            components: [{
                type: ComponentType.TextDisplay,
                content: [
                    `### Reported user: @${row.username}`,
                    `<@${row.user_id}> • ${[row.global_name && `global: **${sanitize(row.global_name)}**`, row.nick && `nick: **${sanitize(row.nick)}**`].filter(Boolean).join(" • ")}`,
                    `-# account <t:${row.account_at}:R>${row.joined_at ? ` • joined server <t:${row.joined_at}:R>` : ""}`,
                    ...(links.length > 0 ? [`Images: ${links.join(" | ")}`] : []),
                ].filter(l => l.length > 0).join("\n"),
            }],
            accessory: {
                type: ComponentType.Thumbnail,
                media: { url: cdn.avatar(row.user_id, row.avatar ?? row.server_avatar ?? null) || `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(row.user_id) >> 22n) % 6n)}.png` },
            },
        },
    ] as NonNullable<RESTPostAPIChannelMessageJSONBody["components"]>;
}

function reporterLine(r: cache.StoredReporter): string {
    return `**${r.u === "anonymous" ? "Anonymous" : `<@${r.u}>`}** • <t:${r.t}:R>\n${r.c ? quote(r.c) : "-# *(no extra context)*"}`;
}

function buildGroupedBody(kind: "m" | "u", row: cache.MessageReportRow | cache.UserReportRow, urgentRoleId: string | null, pingUrgent: boolean): RESTPostAPIChannelMessageJSONBody {
    const inner: RESTPostAPIChannelMessageJSONBody["components"] = [];
    // once urgent, the marker stays on the message even if a later grouped report doesn't opt in
    const showUrgent = !!row.urgent && !!urgentRoleId;
    inner.push(...(kind === "m"
        ? messageContentComponents(row as cache.MessageReportRow)
        : userContentComponents(row as cache.UserReportRow)));
    inner.push({ type: ComponentType.Separator });
    let first = true;
    for (const r of (row.reporters ?? []).slice(-12)) {
        inner.push({
            type: ComponentType.TextDisplay,
            content: `${first ? "### Reporter notes\n" : ""}${reporterLine(r)}`,
        });
        first = false;
    }

    const container = {
        type: ComponentType.Container,
        accent_color: 0xe67e22,
        components: inner,
    } as NonNullable<RESTPostAPIChannelMessageJSONBody["components"]>[number];

    // urgent ping + jump button live outside the container, like a traditional embed
    const components: NonNullable<RESTPostAPIChannelMessageJSONBody["components"]> = [];
    if (showUrgent) {
        components.push({ type: ComponentType.TextDisplay, content: `<@&${urgentRoleId}> - **marked urgent**` });
    }
    components.push(container);

    const jumpRow = kind === "m" ? inner.find(c => c.type === ComponentType.ActionRow) : undefined;
    if (jumpRow) {
        const idx = inner.indexOf(jumpRow);
        inner.splice(idx, 1);
        components.push(jumpRow);
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        // only THIS submission's opt-in grants an actual ping; the line itself persists via row.urgent
        allowed_mentions: urgentRoleId && pingUrgent ? { parse: [], roles: [urgentRoleId] } : {},
        components,
    } as RESTPostAPIChannelMessageJSONBody;
}

function manualComponents(context: string, evidence: cache.StoredAttachment[], user: APIUser, anonymous: boolean, urgentRoleId: string | null, pingUrgent: boolean): RESTPostAPIChannelMessageJSONBody {
    const small = evidence.filter(isSmall);
    const big = evidence.filter(a => !isSmall(a));
    const inner: RESTPostAPIChannelMessageJSONBody["components"] = [];
    inner.push({
        type: ComponentType.TextDisplay,
        content: `### General report\n${quote(context)}${big.length > 0 ? `\n-# too large to rehost: ${big.map(a => `[${a.n}](${a.u})`).join(" | ")}` : ""}`,
    });
    if (small.length > 0) {
        const images = small.filter(a => a.ct?.startsWith("image/"));
        const files = small.filter(a => !a.ct?.startsWith("image/"));
        if (images.length > 0) {
            inner.push({
                type: ComponentType.MediaGallery,
                items: images.map(a => ({ media: { url: `attachment://${a.n}` } })),
            });
        }
        if (files.length > 0) {
            for (const a of files) {
                inner.push({
                    type: ComponentType.File,
                    file: { url: `attachment://${a.n}` },
                });
            }
        }
    }
    inner.push({ type: ComponentType.Separator });
    inner.push({
        type: ComponentType.TextDisplay,
        content: `-# reported by ${anonymous ? "**someone anonymous**" : `**<@${user.id}>** (${user.username})`} • <t:${Math.floor(Date.now() / 1000)}:R>`,
    });

    const components: NonNullable<RESTPostAPIChannelMessageJSONBody["components"]> = [];
    if (urgentRoleId && pingUrgent) {
        components.push({ type: ComponentType.TextDisplay, content: `<@&${urgentRoleId}> - **marked urgent**` });
    }
    components.push({
        type: ComponentType.Container,
        accent_color: 0xe67e22,
        components: inner,
    } as NonNullable<RESTPostAPIChannelMessageJSONBody["components"]>[number]);

    return {
        flags: MessageFlags.IsComponentsV2,
        allowed_mentions: urgentRoleId && pingUrgent ? { parse: [], roles: [urgentRoleId] } : {},
        components,
    };
}

function checkboxLabel(label: string, description: string, customId: string): NonNullable<APIModalInteractionResponseCallbackData["components"]>[number] {
    return {
        type: ComponentType.Label,
        label,
        description,
        component: { type: ComponentType.Checkbox, custom_id: customId, default: false },
    };
}

const hasPerms = (perms: bigint, needed: bigint) =>
    (perms & PermissionFlagsBits.Administrator) !== 0n || (perms & needed) === needed;

// cdn url builders — cache stores hashes, urls are derived on render
const cdn = {
    avatar: (userId: string, hash: string | null) =>
        hash ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=256` : null,
    guildAvatar: (guildId: string, userId: string, hash: string | null) =>
        hash ? `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=256` : null,
    banner: (userId: string, hash: string | null) =>
        hash ? `https://cdn.discordapp.com/banners/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=600` : null,
    guildBanner: (guildId: string, userId: string, hash: string | null) =>
        hash ? `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/banners/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=600` : null,
};

client.on(GatewayDispatchEvents.InteractionCreate, async ({ data: interaction, api }) => {
    const guildId = interaction.guild_id;
    const userId = interaction.member?.user.id || interaction.user?.id;
    if (!userId) return console.error("No user ID found in interaction, skipping????");

    try {
        // /config -> open setup modal
        if (guildId && interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "config") {
            const config = await db.getConfig(guildId);
            await api.interactions.createModal(interaction.id, interaction.token, {
                title: "Report Config",
                custom_id: "report_config_modal",
                components: [
                    {
                        type: ComponentType.Label,
                        label: "Report Channel",
                        description: "Where user reports will be sent",
                        component: {
                            type: ComponentType.ChannelSelect,
                            custom_id: "report_channel",
                            min_values: 1,
                            max_values: 1,
                            placeholder: "#mod-reports",
                            channel_types: [ChannelType.GuildText, ChannelType.PrivateThread, ChannelType.PublicThread, ChannelType.GuildForum],
                            required: true,
                            default_values: config.report_channel_id ? [{ id: config.report_channel_id, type: SelectMenuDefaultValueType.Channel }] : [],
                        },
                    },
                    checkboxLabel("Anonymous Reporting", "Adds an opt-out checkbox to reports", "anonymous_enabled"),
                    {
                        type: ComponentType.Label,
                        label: "Urgent Role",
                        description: "Optional role reporters can choose to ping",
                        component: {
                            type: ComponentType.RoleSelect,
                            custom_id: "urgent_role",
                            min_values: 0,
                            max_values: 1,
                            placeholder: "@Moderators",
                            required: false,
                            default_values: config.urgent_role_id ? [{ id: config.urgent_role_id, type: SelectMenuDefaultValueType.Role }] : [],
                        },
                    },
                ],
            });
            return;
        }

        // config modal submit -> validate & save
        else if (guildId && interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id === "report_config_modal") {
            const prevConfig = await db.getConfig(guildId);
            let channelId = prevConfig.report_channel_id;
            let anonymous = prevConfig.anonymous_enabled;
            let urgentRole = prevConfig.urgent_role_id;
            let useThreads = prevConfig.use_threads;

            for (const label of interaction.data.components) {
                if (label.type !== ComponentType.Label) continue;
                const c = label.component;
                if (!c) continue;
                if (c.type === ComponentType.ChannelSelect && c.custom_id === "report_channel") channelId = c.values[0] ?? channelId;
                if (c.type === ComponentType.RoleSelect && c.custom_id === "urgent_role") urgentRole = c.values[0] ?? null;
                if (c.type === ComponentType.Checkbox && c.custom_id === "anonymous_enabled") anonymous = c.value;
            }

            // early permission check via the resolved channel so we don't save a broken config
            if (channelId) {
                const resolvedChannels = ("resolved" in interaction.data ? interaction.data.resolved?.channels : undefined) ?? {};
                const ch = resolvedChannels[channelId];
                if (!ch) {
                    return api.interactions.reply(interaction.id, interaction.token, {
                        content: `<#${channelId}> couldn't be found — it may have been deleted.\n-# No settings have been changed.`,
                        flags: MessageFlags.Ephemeral,
                        allowed_mentions: {},
                    });
                }
                // forum/media channels receive one thread per report instead of plain messages
                useThreads = ch.type === ChannelType.GuildForum;
                const isThread = ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread;

                const needed = useThreads
                    ? PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.SendMessages
                    : isThread
                        ? PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.SendMessages
                        : PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
                const neededLabels = useThreads
                    ? "**View Channel**, **Create Posts** and **Send Messages in Posts**"
                    : isThread
                        ? "**View Channel**, **Send Messages in Threads** and **Send Messages**"
                        : "**View Channel** and **Send Messages**";

                if (!hasPerms(BigInt(ch.app_permissions ?? "0"), needed)) {
                    return api.interactions.reply(interaction.id, interaction.token, {
                        content: `I can't send reports to <#${channelId}> — I need the ${neededLabels} permissions there.\n-# No settings have been changed.`,
                        flags: MessageFlags.Ephemeral,
                        allowed_mentions: {},
                    });
                }
                if (!hasPerms(BigInt(ch.permissions ?? "0"), needed)) {
                    return api.interactions.reply(interaction.id, interaction.token, {
                        content: `You need the ${neededLabels} permissions in <#${channelId}> to set it as the report channel.\n-# No settings have been changed.`,
                        flags: MessageFlags.Ephemeral,
                        allowed_mentions: {},
                    });
                }
            }

            await db.setConfig(guildId, { report_channel_id: channelId, anonymous_enabled: anonymous, urgent_role_id: urgentRole, use_threads: useThreads });

            if (channelId && (channelId !== prevConfig.report_channel_id || useThreads !== prevConfig.use_threads)) {
                if (useThreads) {
                    api.channels.createForumThread(channelId, {
                        name: forumThreadName("Reports setup complete"),
                        message: { content: "⚙️ This forum will now receive user reports (one thread per report).", allowed_mentions: {} },
                    }).catch(() => null);
                } else {
                    api.channels.createMessage(channelId, { content: "⚙️ This channel will now receive user reports.", allowed_mentions: {} }).catch(() => null);
                }
            }

            await api.interactions.reply(interaction.id, interaction.token, {
                content:
                    "Report config updated!\n" +
                    `-# - Reports go to: ${channelId ? `<#${channelId}>${useThreads ? " (threads)" : ""}` : "*(not set)*"}\n` +
                    `-# - Anonymous reporting: **${anonymous ? "enabled" : "disabled"}**\n` +
                    `-# - Urgent role: ${urgentRole ? `<@&${urgentRole}>` : "*(not set)*"}`,
                allowed_mentions: {},
            });
            return;
        }

        // /report + context menus -> upsert cache & open report modal
        else if (
            guildId && interaction.type === InteractionType.ApplicationCommand
            && (interaction.data.name === "report" || interaction.data.name === "Report Message" || interaction.data.name === "Report User")
        ) {
            const config = await db.getConfig(guildId);
            if (!config.report_channel_id) {
                return api.interactions.reply(interaction.id, interaction.token, {
                    content: `Reports aren't set up on this server yet. An admin needs to run </config:${commandIds["config"] ?? "0"}> first.`,
                    flags: MessageFlags.Ephemeral,
                    allowed_mentions: {},
                });
            }

            const resolved = ("resolved" in interaction.data ? interaction.data.resolved : undefined) as (APIInteractionDataResolved & { messages?: Record<string, APIMessage> }) | undefined;
            const targetId = "target_id" in interaction.data ? interaction.data.target_id : null;
            const sourceChannelId = interaction.channel?.id;
            const ephemeralReply = (content: string) =>
                api.interactions.reply(interaction.id, interaction.token, { content, flags: MessageFlags.Ephemeral, allowed_mentions: {} });

            let title = "Report";
            let customSuffix = "x";
            let previewBlocks: string[] = [];

            if (interaction.data.name === "Report Message") {
                const msg = resolved?.messages?.[targetId!];
                if (!msg || !sourceChannelId) return ephemeralReply("That message couldn't be loaded anymore.");

                const attributedUser = msg.author.bot ? msg.interaction_metadata?.user ?? msg.interaction?.user ?? null : msg.author;
                if (!attributedUser) return ephemeralReply("You can't report bot messages.");

                const snap = snapshotOf(msg);
                // edits change the evidence -> treat as its own report
                const editStamp = msg.edited_timestamp ? Math.floor(Date.parse(msg.edited_timestamp) / 1000) : 0;
                const key = `${guildId}_${msg.id}_${editStamp}`;
                let row = cache.getMessageReport(key);
                // stale rows are left for the prune cron — someone may still be mid-modal on them
                if (row && Date.now() - row.last_at > GROUP_FRESH_MS) row = null;
                if (!row) {
                    const attachments = Object.values(snap?.attachments ?? msg.attachments);
                    const names = uniqueFileNames(attachments);
                    const stored = attachments.map((a, i): cache.StoredAttachment => ({
                        n: names[i]!,
                        u: a.url,
                        s: a.size,
                        ct: a.content_type ?? null,
                    }));
                    const images = stored.filter(a => a.ct?.startsWith("image/")).slice(0, 10);
                    const files = stored.filter(a => !a.ct?.startsWith("image/")).slice(0, 10);
                    row = {
                        key,
                        guild_id: guildId,
                        source_channel_id: sourceChannelId,
                        source_channel_name: interaction.channel?.name ?? "",
                        msg_id: msg.id,
                        author_id: attributedUser.id,
                        username: attributedUser.username,
                        forwarded: !!snap,
                        app_command: !!msg.interaction_metadata || !!msg.interaction,
                        content: (snap?.content || msg.content || "").slice(0, 2000),
                        images,
                        files,
                        urgent: false,
                        log_channel_id: config.report_channel_id,
                        log_message_id: null,
                        reporters: [],
                        last_at: Date.now(),
                    };
                } else {
                    // refresh editable bits & keep the grouping window alive
                    row.username = attributedUser.username;
                }
                cache.setMessageReport(row);

                title = "Reported message";
                customSuffix = `m:${key}`;
                previewBlocks = [messageBlockTextFromRow(row)];
            } else if (interaction.data.name === "Report User") {
                const user = resolved?.users?.[targetId!];
                const member = targetId ? resolved?.members?.[targetId] : undefined;
                if (!user || !targetId) return ephemeralReply("That user couldn't be loaded anymore.");

                // a changed profile is different evidence -> its own report, like message edits
                const profileStamp = Bun.hash([user.username, user.global_name ?? "", user.avatar ?? "", member?.avatar ?? "", user.banner ?? "", member?.banner ?? ""].join("|")).toString(16);
                const key = `${guildId}_${user.id}_${profileStamp}`;
                let row = cache.getUserReport(key);
                // stale rows are left for the prune cron — someone may still be mid-modal on them
                if (row && Date.now() - row.last_at > GROUP_FRESH_MS) row = null;
                if (!row) {
                    row = {
                        key,
                        guild_id: guildId,
                        user_id: user.id,
                        username: user.username,
                        global_name: user.global_name,
                        nick: member?.nick ?? null,
                        account_at: snowflakeDate(user.id),
                        joined_at: member?.joined_at ? Math.floor(new Date(member.joined_at).getTime() / 1000) : null,
                        avatar: user.avatar,
                        server_avatar: member?.avatar ?? null,
                        banner: user.banner ?? null,
                        server_banner: member?.banner ?? null,
                        log_channel_id: config.report_channel_id,
                        log_message_id: null,
                        urgent: false,
                        last_at: Date.now(),
                    };
                } else {
                    // refresh editable bits & keep the grouping window alive
                    row.username = user.username;
                    row.global_name = user.global_name;
                    row.nick = member?.nick ?? null;
                    row.joined_at ||= member?.joined_at ? Math.floor(new Date(member.joined_at).getTime() / 1000) : null;
                    row.server_avatar ||= member?.avatar ?? null;
                    row.banner ||= user.banner ?? null;
                    row.server_banner ||= member?.banner ?? null;
                    row.avatar ||= user.avatar ?? null;
                }
                cache.setUserReport(row);

                title = "Reported user";
                customSuffix = `u:${key}`;
                previewBlocks = [userBlockTextFromRow(row)];
            }

            const modalComponents: NonNullable<APIModalInteractionResponseCallbackData["components"]> = [];
            for (const block of previewBlocks.slice(0, 1)) {
                modalComponents.push({ type: ComponentType.TextDisplay, content: block });
            }
            const isUser = customSuffix.startsWith("u:");
            const isManual = customSuffix === "x";
            modalComponents.push({
                type: ComponentType.Label,
                label: isUser ? "Describe The Issue" : isManual ? "Report Details" : "Additional Context",
                description: isUser
                    ? "What did they do? Be as detailed as possible"
                    : isManual
                        ? "What are you reporting? Be as detailed as possible"
                        : "Anything the moderators should know (optional)",
                component: {
                    type: ComponentType.TextInput,
                    custom_id: "context",
                    style: TextInputStyle.Paragraph,
                    required: isManual,
                    max_length: isManual ? 2000 : 500,
                    placeholder: isUser
                        ? "Describe why you're reporting this user..."
                        : isManual
                            ? "Describe what happened..."
                            : "Why are you reporting this?",
                },
            });
            if (customSuffix === "x") {
                modalComponents.push({
                    type: ComponentType.Label,
                    label: "Image Evidence",
                    description: "Attach screenshots (images only)",
                    component: {
                        type: ComponentType.FileUpload,
                        custom_id: "evidence_files",
                        min_values: 0,
                        max_values: 5,
                        file_types: ["image"],
                        required: false,
                    },
                });
            }
            if (config.urgent_role_id) {
                modalComponents.push(checkboxLabel("Ping Moderators", "Urgently notify the mod role (use wisely)", "ping_urgent"));
            }
            if (config.anonymous_enabled) {
                modalComponents.push(checkboxLabel("Report Anonymously", "Your name won't be shown in the report", "anonymous"));
            }
            modalComponents.push({
                type: ComponentType.TextDisplay,
                content: "-# If this violates Discord's rules, report it to Discord too — see [reporting abusive behavior to Discord](https://discord.com/safety/360044103651-reporting-abusive-behavior-to-discord \"Reporting Content or Behaviour to Discord\").",
            });

            await api.interactions.createModal(interaction.id, interaction.token, { title, custom_id: `report:${customSuffix}`, components: modalComponents });
            return;
        }

        // report modal submit -> post/edit into log channel
        else if (guildId && interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id.startsWith("report:")) {
            let deferredPromise = false as false | Promise<true>;
            const deferTimeout = setTimeout(() => {
                deferredPromise = api.interactions.defer(interaction.id, interaction.token, { flags: MessageFlags.Ephemeral })
                    .then(() => true);
            }, 2500);

            const replyEphemeral = async (content: string) => {
                clearTimeout(deferTimeout);
                const body = { content, flags: MessageFlags.Ephemeral, allowed_mentions: {} };
                if (await deferredPromise) return api.interactions.editReply(interaction.application_id, interaction.token, body);
                return api.interactions.reply(interaction.id, interaction.token, body);
            };

            const [, kindRaw, key] = interaction.data.custom_id.split(":");
            const config = await db.getConfig(guildId);
            if (!config.report_channel_id) return replyEphemeral("Reports aren't set up on this server anymore.");

            let context: string | null = null;
            let evidenceAtts: cache.StoredAttachment[] = [];
            let pingUrgent = false;
            let anonymous = false;

            for (const label of interaction.data.components) {
                if (label.type !== ComponentType.Label) continue;
                const c = label.component;
                if (!c) continue;
                if (c.type === ComponentType.TextInput && c.custom_id === "context") context = c.value.trim() || null;
                else if (c.type === ComponentType.FileUpload && c.custom_id === "evidence_files") {
                    const picked = c.values.map(id => interaction.data.resolved?.attachments?.[id]).filter((a): a is APIAttachment => !!a).slice(0, 5);
                    const names = uniqueFileNames(picked);
                    evidenceAtts = picked.map((a, i): cache.StoredAttachment => ({ n: names[i]!, u: a.url, s: a.size, ct: a.content_type ?? null }));
                }
                else if (c.type === ComponentType.Checkbox && c.custom_id === "ping_urgent") pingUrgent = c.value;
                else if (c.type === ComponentType.Checkbox && c.custom_id === "anonymous") anonymous = c.value;
            }

            const user = interaction.member?.user || interaction.user!;
            const now = Math.floor(Date.now() / 1000);

            try {
                const useThreads = config.use_threads;
                const targetChannelId = config.report_channel_id!;
                if (kindRaw === "x") {
                    if (!context) return replyEphemeral("You need to describe what you're reporting.");
                    const files = await downloadSmall(evidenceAtts);
                    const body = manualComponents(context, evidenceAtts, user, anonymous, config.urgent_role_id, pingUrgent);
                    if (useThreads) {
                        await api.channels.createForumThread(targetChannelId, {
                            name: forumThreadName(`Report — ${context.split("\n")[0]?.slice(0, 60) || user.username}`),
                            message: { ...body, files },
                        });
                    } else {
                        await api.channels.createMessage(targetChannelId, {
                            files,
                            ...body,
                        });
                    }
                } else {
                    const row = kindRaw === "m" ? cache.getMessageReport(key!) : cache.getUserReport(key!);
                    if (!row || Date.now() - row.last_at > GROUP_FRESH_MS) {
                        return replyEphemeral("This report session expired, please run the command again.");
                    }

                    const wasExisting = !!row.log_message_id;
                    const wasUrgent = row.urgent;
                    const prevLogChannelId = row.log_channel_id;
                    if (pingUrgent) row.urgent = true;
                    cache.appendReporter(kindRaw as "m" | "u", key!, { u: anonymous ? "anonymous" : user.id, t: now, c: context });

                    const threadName = kindRaw === "m"
                        ? forumThreadName(`Report — @${(row as cache.MessageReportRow).username || (row as cache.MessageReportRow).author_id}${(row as cache.MessageReportRow).source_channel_name ? ` in #${(row as cache.MessageReportRow).source_channel_name}` : ""}`)
                        : forumThreadName(`Report — @${(row as cache.UserReportRow).username}`);

                    // forum threads: thread id == starter message id, so we store the thread id
                    // as the log channel and edit the starter via editMessage(threadId, threadId)
                    const swapAttachmentUrls = (mRow: cache.MessageReportRow, attachments: { filename: string; url: string }[] | Record<string, { filename: string; url: string }> | undefined) => {
                        if (!attachments) return;
                        const byName = new Map(Object.values(attachments).map(a => [a.filename, a.url]));
                        for (const a of [...mRow.images, ...mRow.files]) {
                            const freshUrl = byName.get(a.n);
                            if (freshUrl) a.u = freshUrl;
                        }
                    };
                    const createNewLog = async (newBody: RESTPostAPIChannelMessageJSONBody, newFiles: RawFile[]) => {
                        if (useThreads) {
                            const thread = await api.channels.createForumThread(targetChannelId, {
                                name: threadName,
                                message: { ...newBody, files: newFiles },
                            });
                            // fetch the starter to resolve our own stable cdn urls for attachments
                            const starter = await api.channels.getMessage(thread.id, thread.id).catch(() => null);
                            return { logChannelId: thread.id as string, logMessageId: thread.id as string, attachments: starter?.attachments };
                        }
                        const posted = await api.channels.createMessage(targetChannelId, { files: newFiles, ...newBody });
                        return { logChannelId: targetChannelId as string, logMessageId: posted.id as string, attachments: posted.attachments };
                    };

                    let logMessageId = row.log_message_id;
                    // where the log message actually lives (thread id for forum posts)
                    let logChannelId = prevLogChannelId;
                    let files: RawFile[] = [];
                    if (!logMessageId && kindRaw === "m") {
                        // download first so failures demote to links before the body is built
                        files = await downloadSmall([...(row as cache.MessageReportRow).images, ...(row as cache.MessageReportRow).files].filter(isSmall));
                    }
                    const body = buildGroupedBody(kindRaw as "m" | "u", { ...row, reporters: cache.getReporters(kindRaw as "m" | "u", key!) }, config.urgent_role_id, pingUrgent);

                    try {
                        if (logMessageId) {
                            // edits keep the original attachments; refs match by filename so no re-upload needed
                            // edit where the message actually lives, even if the configured channel changed
                            await api.channels.editMessage(prevLogChannelId, logMessageId, body);
                        } else {
                            const created = await createNewLog(body, files);
                            logMessageId = created.logMessageId;
                            logChannelId = created.logChannelId;
                            if (kindRaw === "m") {
                                // swap source urls for our own stable cdn urls
                                swapAttachmentUrls(row as cache.MessageReportRow, created.attachments);
                            }
                        }
                    } catch (err) {
                        if (!(err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === RESTJSONErrorCodes.UnknownChannel))) throw err;
                        logMessageId = null;
                    }

                    // message got deleted mid-window -> recreate from our own copies
                    if (!logMessageId) {
                        let retryFiles: RawFile[] = [];
                        if (kindRaw === "m") {
                            retryFiles = await downloadSmall([...(row as cache.MessageReportRow).images, ...(row as cache.MessageReportRow).files].filter(isSmall));
                        }
                        // rebuild: some attachments may have just been demoted to links
                        const retryBody = buildGroupedBody(kindRaw as "m" | "u", row, config.urgent_role_id, pingUrgent);
                        const created = await createNewLog(retryBody, retryFiles);
                        logMessageId = created.logMessageId;
                        logChannelId = created.logChannelId;
                        if (kindRaw === "m") {
                            swapAttachmentUrls(row as cache.MessageReportRow, created.attachments);
                        }
                    }
                    row.log_message_id = logMessageId;
                    row.log_channel_id = logChannelId;

                    // targeted updates only — reporters already appended, parent just tracks the log target/freshness
                    cache.setReportLogTarget(kindRaw as "m" | "u", key!, logChannelId, logMessageId);
                    if (pingUrgent && !wasUrgent && config.urgent_role_id) {
                        cache.markReportUrgent(kindRaw as "m" | "u", key!);
                    }

                    // original wasn't urgent but an existing grouped message just became urgent -> reply pinging the mod role (one-off)
                    if (!wasUrgent && pingUrgent && wasExisting && config.urgent_role_id) {
                        if (logChannelId === logMessageId) {
                            // forum thread: reply inside the thread to the starter
                            api.channels.createMessage(logMessageId, {
                                content: `<@&${config.urgent_role_id}> - a report was just marked as urgent`,
                                message_reference: { message_id: logMessageId },
                                allowed_mentions: { parse: [], roles: [config.urgent_role_id] },
                            }).catch(() => null);
                        } else {
                            api.channels.createMessage(config.report_channel_id, {
                                content: `<@&${config.urgent_role_id}> - a report was just marked as urgent`,
                                message_reference: { message_id: logMessageId },
                                allowed_mentions: { parse: [], roles: [config.urgent_role_id] },
                            }).catch(() => null);
                        }
                    }
                }
            } catch (err) {
                console.error(`Failed posting report: ${err}`);
                return replyEphemeral("There was a problem sending your report, please try again later.");
            }

            const anonNote = anonymous ? "\n-# You reported anonymously." : "";
            return void replyEphemeral(`Your report has been submitted to the moderators.${anonNote}`);
        }
    } catch (err) {
        let interactionInfo = "";
        if (interaction.type === InteractionType.ApplicationCommand) interactionInfo = `/${interaction.data.name}`;
        else if (interaction.type === InteractionType.ModalSubmit) interactionInfo = `modal ${(interaction as APIModalSubmitInteraction).data.custom_id}`;
        console.error(`Error with InteractionCreate handler [${interactionInfo}]: ${err}`);
    }
});

function messageBlockTextFromRow(row: cache.MessageReportRow): string {
    const atts = [...row.images, ...row.files];
    return [
        `### Reported message by @${row.username || "unknown"}`,
        ...(row.content ? [quote(row.content).slice(0, 2000)] : ["-# *(no text content)*"]),
        `**By:** <@${row.author_id}> • <t:${snowflakeDate(row.msg_id)}:f>${row.forwarded ? " • forwarded" : ""}${row.app_command ? " • app command" : ""}`,
        ...(atts.length > 0 ? [`Attachments: ${atts.map(a => `[${a.n}](${a.u})`).join(" | ")}`] : []),
    ].join("\n");
}

function sanitize(text: string): string {
    return text.replace(/[*_~`|\\\n]/g, "");
}

function userBlockTextFromRow(row: cache.UserReportRow): string {
    const links: string[] = [];
    if (row.avatar) links.push(`[pfp](${cdn.avatar(row.user_id, row.avatar)})`);
    if (row.server_avatar) links.push(`[server pfp](${cdn.guildAvatar(row.guild_id, row.user_id, row.server_avatar)})`);
    if (row.banner) links.push(`[banner](${cdn.banner(row.user_id, row.banner)})`);
    if (row.server_banner) links.push(`[server banner](${cdn.guildBanner(row.guild_id, row.user_id, row.server_banner)})`);
    return [
        `### Reported user: @${row.username}`,
        `<@${row.user_id}> • ${[row.global_name && `global: **${sanitize(row.global_name)}**`, row.nick && `nick: **${sanitize(row.nick)}**`].filter(Boolean).join(" • ")}`,
        `-# account <t:${row.account_at}:R>${row.joined_at ? ` • joined server <t:${row.joined_at}:R>` : ""}`,
        ...(links.length > 0 ? [`Images: ${links.join(" | ")}`] : []),
    ].filter(l => l.length > 0).join("\n");
}


await db.initDb();
gateway.connect();
