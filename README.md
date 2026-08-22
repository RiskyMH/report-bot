# Report Bot

A Discord report bot — users report messages or users straight from the context menu (or via `/report` for anything else), and reports land in a moderator-configured log channel.

## Features

### `/config` *(Manage Server)*
Modal to set:
- **Report channel** — channel to send reports to; bot requires permissions to send in it (`View Channel` + `Send Messages`)
- **Anonymous reporting** — adds an opt-out checkbox to all report flows.
- **Urgent role** — optional role that reporters can choose to ping when things are time-sensitive.

### `Report Message` context menu
- Snapshot of the message is composed from the interaction's own resolved data.
- Handles forwards and slash command bot messages (attributes the interacting user).
- Images shown as media gallery, other files as file components — anything over 25MB sent via masked links.
- Optional additional reporter notes.

### `Report User` context menu
- Mention, account age and join date, plus masked links for global/server avatar & banner.
- Avatar thumbnail in the section accessory.
- Optional additional reporter notes.

### `/report`
Free-form report with required details (2000 chars) and optional image evidence uploads.

### Grouping
Reports for the same target within **5 minutes** edit the original log message and append reporter notes instead of spamming new messages. Edited messages count as their own report.

If an existing grouped report gets newly flagged urgent, the bot replies to the log message pinging the mod role.

## Setup

Requires [Bun](https://bun.com).

```bash
bun install
DISCORD_TOKEN=your_token_here bun run dev
```

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `DATABASE_URL` | no | Config DB. Defaults to `sqlite://report-bot.sqlite`. |
| `REPORT_CACHE_DB` | no | Grouping-cache DB path. Defaults to `report-cache.sqlite`. |

Both databases are created automatically.

The bot is also fully containerized:

```bash
bun run docker:build   # build the image
bun run docker:deploy  # deploy with docker compose
bun run docker:logs    # tail the logs
```
