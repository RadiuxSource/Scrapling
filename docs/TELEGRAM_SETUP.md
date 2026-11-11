# Telegram setup and fallback guide

Vortex supports a personal Telegram bot/channel configuration per browser workspace, plus deployment-level default video-delivery bot and a separate operational log/backup destination.

## Configure your own bot and channel

1. In Telegram, open @BotFather, run /newbot, and copy the HTTP Bot API token.
2. Create or choose the destination channel.
3. Add your bot to that channel as an administrator and grant permission to post messages.
4. Enter both the bot token and channel ID in Vortex's Telegram Hub.
5. Save the configuration and use Verify & Send Test Message.

For a public channel, use @channel_username. For a private channel, use its numeric chat ID (normally beginning with -100).

## Fallback behavior

| User bot token | User channel ID | Bot used | Destination |
|---|---|---|---|
| Present | Present | User's bot | User's channel |
| Missing | Present | Deployment default bot | User's channel |
| Present | Missing | Deployment default bot | Deployment default log/backup channel |
| Missing | Missing | Deployment default bot | Deployment default log/backup channel |

If only a channel is entered, add the deployment's default bot to that channel as an administrator with posting permission.

If only a bot is entered without a channel ID, the incomplete custom pair is ignored and the deployment default bot plus default log/backup channel are used. Enter both custom values to use your own bot.

Vortex displays a warning while only one side of a custom bot/channel pair is configured. The warning clears when both sides are supplied, or when the saved configuration already contains the corresponding bot credential.

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
- `LOG_TELEGRAM_CHAT_ID`: private log group/channel destination. This is the default destination when a browser does not provide a complete custom bot/channel pair.
- `TELEGRAM_BOT_TOKEN`: platform's main video-delivery bot. This is the bot displayed in Telegram Hub as the channel-upload bot and the bot users add to their media channels when using fallback delivery.
- `LOG_TELEGRAM_BOT_TOKEN`: dedicated monitoring bot token. It is used only for private operational logs and owner commands; it is not the channel video-delivery bot.

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

The log group is operational-only. User media uploads continue to use the configured per-browser media destination and are not redirected to the private log group.

### Dedicated forum topic (optional)

You do not need a separate group if you already have a Telegram supergroup with Topics enabled. Add the default monitoring bot as an administrator with permission to manage topics. If `LOG_TELEGRAM_THREAD_ID` is blank, Vortex attempts to create a **Vortex Operational Logs** topic automatically using the Bot API. If topic creation is unavailable, it falls back to posting in the main group. You can instead set `LOG_TELEGRAM_THREAD_ID` to an existing topic ID.

The video-delivery bot username (workspace bot if configured, otherwise `TELEGRAM_BOT_TOKEN`) is displayed in the Telegram Hub and can also be read from `/api/telegram/default-bot`. The dedicated log bot username is never presented as the channel-upload bot. The Bot API cannot create a brand-new group or supergroup. A human group owner must create that group and add the bot; Vortex can then create a topic inside it when the required permissions are granted.

## Koyeb setup checklist

1. In Telegram, create a private supergroup yourself and add the monitoring bot. Promote it to administrator with permission to send messages and documents. Enable Topics and grant Manage Topics if you want Vortex to create its own log topic.
2. Set `TELEGRAM_BOT_TOKEN` to the main video-delivery bot token that users will add to their channels. Separately, create a dedicated monitoring bot with `@BotFather`; do not configure a webhook for it, and copy its token into Koyeb as `LOG_TELEGRAM_BOT_TOKEN`.
3. Obtain the supergroup's numeric chat ID (commonly a negative ID beginning with `-100`) using a Telegram chat-ID utility such as `@RawDataBot`, then remove the utility bot if you do not want it in the group.
4. In Koyeb, open the service's **Settings → Environment variables** and add:
   - `OWNER_ACCESS_SECRET` — generate with `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
   - `OWNER_TELEGRAM_USER_ID` — your numeric personal Telegram ID from `@userinfobot`.
   - `LOG_TELEGRAM_CHAT_ID` — the private supergroup ID.
   - `LOG_TELEGRAM_BOT_TOKEN` — the dedicated BotFather token.
   - Leave `LOG_TELEGRAM_THREAD_ID` blank to let Vortex create its own forum topic, or set an existing topic ID.
5. Keep your existing `WORKSPACE_SECRET`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` unchanged. Also run the latest `supabase-queue-schema.sql` in Supabase SQL Editor; its migration removes legacy CHECK constraints attached to the queue table's `id` column, including renamed constraints that reject `ws_<uuid>` workspace IDs. Do not put any of these secrets in the browser UI or commit them to Git.
6. Redeploy the service. Open `https://YOUR-DOMAIN/owner` and sign in with `OWNER_ACCESS_SECRET`. In the log group, use `/start` to verify bot connectivity and uptime, `/help` for commands, then reply to an action message with `/logs`.

If you omit `LOG_TELEGRAM_BOT_TOKEN`, owner monitoring falls back to `TELEGRAM_BOT_TOKEN`; that main bot must then have no webhook configured for owner commands to work. A dedicated log bot is safer because long polling can conflict with an existing webhook integration.
