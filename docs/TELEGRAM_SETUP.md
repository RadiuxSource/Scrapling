# Telegram setup and fallback guide

Vortex supports a personal Telegram bot/channel configuration per browser workspace, plus deployment-level defaults for the platform's shared log/backup destination.

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