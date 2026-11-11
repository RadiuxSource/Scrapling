# Telegram setup and fallback guide

Vortex uses a deployment-owned Telegram archive for every completed video. When a workspace supplies its own channel ID, Vortex uploads the media to the archive once and forwards Telegram's stored message to that channel. It does not upload the same file twice. The existing extraction and download paths are unchanged.

## Configure your own bot and channel

1. In Telegram, open @BotFather, run /newbot, and copy the HTTP Bot API token.
2. Create or choose the destination channel.
3. Add your bot to that channel as an administrator and grant permission to post messages.
4. Enter both the bot token and channel ID in Vortex's Telegram Hub.
5. Save the configuration and use Verify & Send Test Message.

For a public channel, use @channel_username. For a private channel, use its numeric chat ID (normally beginning with -100).

## Fallback behavior

| Workspace bot token | Workspace channel ID | Behavior |
|---|---|---|
| Present | Present | Platform archive bot uploads once to the archive, then forwards that Telegram message to the workspace channel. |
| Missing | Present | Same archive-first forwarding using the platform bot. |
| Present | Missing | Archive-only; no user channel is configured. |
| Missing | Missing | Archive-only; no user channel is configured. |

The archive destination is resolved in this order: `TELEGRAM_BACKUP_CHAT_ID`, `LOG_TELEGRAM_CHAT_ID`, then `TELEGRAM_CHAT_ID`. The sender is `TELEGRAM_BOT_TOKEN`, with `LOG_TELEGRAM_BOT_TOKEN` as a last-resort fallback. The dedicated archive bot must be an administrator in the archive channel/group and in each user destination channel to forward the archived message. Add the platform video-delivery bot to both destinations with permission to post.

A workspace channel ID alone is enough to request forwarding; users do not need to provide their own bot token. A workspace bot token without a channel ID does not create a destination and videos remain in the internal archive. When no deployment archive is configured, Vortex falls back to the workspace's complete custom bot/channel pair if available.

The operational log bot is kept separate when `TELEGRAM_BOT_TOKEN` is configured. It is not used for media when the platform media bot is available.

## Optional Telegram client API credentials

Telegram API ID and API hash are optional and are used for the larger-file MTProto upload path. Obtain them from my.telegram.org. Treat the API hash as a secret.

## Security and troubleshooting

- Never share or commit bot tokens or API hashes.
- Rotate a token with @BotFather immediately if it is exposed.
- A bot must be a channel administrator with posting permission.
- A channel ID alone does not grant the bot access.
- A successful settings save does not prove Telegram delivery; use the test-message action.
- Deployment defaults are configured by the site operator and are not displayed to users.
- Logs and diagnostic exports must mask credentials and private authorization data.

## Upload size behavior

The Bot API upload path may split larger media into smaller parts. When optional MTProto credentials are configured and supported by the deployment, Vortex can use its large-file upload path. Actual limits depend on Telegram and the deployed engine configuration.
## Owner monitoring and operational log group (11/11/2026)

The deployment operator configures these server-side environment variables:

- `OWNER_ACCESS_SECRET`: long random secret for the protected owner dashboard API. Generate one with `python -c "import secrets; print(secrets.token_urlsafe(48))"` and store it only in Koyeb Secrets.
- `OWNER_TELEGRAM_USER_ID`: numeric Telegram user ID allowed to use owner commands. Get this number by messaging `@userinfobot` from your own Telegram account; use the numeric ID, not your username.
- `LOG_TELEGRAM_CHAT_ID`: operational log group and fallback media archive destination (unless `TELEGRAM_BACKUP_CHAT_ID` is set).
- `TELEGRAM_BACKUP_CHAT_ID`: optional dedicated media archive channel/group. If omitted, Vortex uses `LOG_TELEGRAM_CHAT_ID`, then `TELEGRAM_CHAT_ID`.
- `TELEGRAM_BOT_TOKEN`: platform's main video-delivery/archive bot. Add it as an administrator to the archive and any user channel receiving forwarded messages.
- `LOG_TELEGRAM_BOT_TOKEN`: dedicated monitoring bot token. Used for private operational logs and owner commands; it is only a media sender fallback when `TELEGRAM_BOT_TOKEN` is absent.

Add the dedicated monitoring bot to the log group as an administrator with permission to send messages and documents. Separately, add the main video-delivery bot (`TELEGRAM_BOT_TOKEN`) to media channels when using fallback delivery. Owner commands use Telegram long polling, so the monitoring bot must not have a webhook configured. A dedicated `LOG_TELEGRAM_BOT_TOKEN` is recommended to avoid interfering with another bot integration. If `LOG_TELEGRAM_BOT_TOKEN` is blank, owner monitoring falls back to `TELEGRAM_BOT_TOKEN`; this fallback is for logs only and does not change which bot is used for media delivery. `LOG_TELEGRAM_CHAT_ID` is required; the deprecated `TELEGRAM_CHAT_ID` is not used for owner monitoring. For invite-link creation in a destination channel, the resolved bot must also have permission to invite users. The public endpoint `/api/telegram/default-bot` exposes only the configured bot's public username, never its token.

Owner commands (only the configured numeric owner ID is authorized):

- `/start` — live status, server uptime, start time, Node version, and known browser count.
- `/help` — full command guide with usage and access requirements.
- `/workspaces` — known Browser IDs and activity counts.
- `/userinfo BRW-XXXXXXXXXX` — detailed sanitized workspace report.
- `/botinfos` — Telegram configuration inventory, with tokens masked.
- Reply to a monitoring action's start/end message with `/logs` — receive its action `.txt` file.

Operational monitoring records server starts/stops, queue restore outcomes, crawl/download lifecycle events, browser IDs, queue counts, and diagnostic errors. Each tracked action has a stable action ID; start and end Telegram message IDs are indexed for `/logs`. The system never exports raw bot tokens, Telegram API hashes, Supabase service keys, workspace signing secrets, or owner secrets.

Each workspace receives a stable label such as `BRW-4A91C6D2F0`. This is a pseudonymous browser workspace ID, not a verified person's identity. Browser names are null unless explicitly supplied; IP addresses, browser fingerprints, and raw user-agent strings are not collected for this feature.

Every completed video is retained in the configured internal media archive. Operational log messages remain separate in the log group/topic; when the same group is used as the archive, media posts appear there alongside the operational log topic or in the group main chat.

### Dedicated forum topic (optional)

You do not need a separate group if you already have a Telegram supergroup with Topics enabled. Add the default monitoring bot as an administrator with permission to manage topics. If `LOG_TELEGRAM_THREAD_ID` is blank, Vortex attempts to create a **Vortex Operational Logs** topic automatically using the Bot API. If topic creation is unavailable, it falls back to posting in the main group. You can instead set `LOG_TELEGRAM_THREAD_ID` to an existing topic ID.

The video-delivery bot username (workspace bot if configured, otherwise `TELEGRAM_BOT_TOKEN`) is displayed in the Telegram Hub and can also be read from `/api/telegram/default-bot`. The dedicated log bot username is never presented as the channel-upload bot. The Bot API cannot create a brand-new group or supergroup. A human group owner must create that group and add the bot; Vortex can then create a topic inside it when the required permissions are granted.

## Koyeb setup checklist

1. In Telegram, create a private supergroup yourself and add the monitoring bot. Promote it to administrator with permission to send messages and documents. Enable Topics and grant Manage Topics if you want Vortex to create its own log topic.
2. Set `TELEGRAM_BOT_TOKEN` to the main video-delivery/archive bot token. Separately, create a dedicated monitoring bot with `@BotFather`; do not configure a webhook for it, and copy its token into Koyeb as `LOG_TELEGRAM_BOT_TOKEN`.
3. Obtain the supergroup's numeric chat ID (commonly a negative ID beginning with `-100`) using a Telegram chat-ID utility such as `@RawDataBot`, then remove the utility bot if you do not want it in the group.
4. In Koyeb, open the service's **Settings → Environment variables** and add:
   - `OWNER_ACCESS_SECRET` — generate with `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
   - `OWNER_TELEGRAM_USER_ID` — your numeric personal Telegram ID from `@userinfobot`.
   - `LOG_TELEGRAM_CHAT_ID` — the private supergroup ID (also the default media archive unless a separate `TELEGRAM_BACKUP_CHAT_ID` is configured).
   - Optional `TELEGRAM_BACKUP_CHAT_ID` — a dedicated channel/group where every completed video is archived.
   - `LOG_TELEGRAM_BOT_TOKEN` — the dedicated BotFather token.
   - Leave `LOG_TELEGRAM_THREAD_ID` blank to let Vortex create its own forum topic, or set an existing topic ID.
5. Keep your existing `WORKSPACE_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` unchanged. Also run the latest `supabase-queue-schema.sql` in Supabase SQL Editor; its migration removes legacy CHECK constraints attached to the queue table's `id` column, including renamed constraints that reject `ws_<uuid>` workspace IDs. Do not put any of these secrets in the browser UI or commit them to Git.
6. Redeploy the service. Open `https://YOUR-DOMAIN/owner` and sign in with `OWNER_ACCESS_SECRET`. In the log group, use `/start` to verify bot connectivity and uptime, `/help` for commands, then reply to an action message with `/logs`.

If you omit `LOG_TELEGRAM_BOT_TOKEN`, owner monitoring falls back to `TELEGRAM_BOT_TOKEN`; that main bot must then have no webhook configured for owner commands to work. A dedicated log bot is safer because long polling can conflict with an existing webhook integration.
