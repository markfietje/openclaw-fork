---
summary: "Install and configure the external QQ Bot channel plugin"
read_when:
  - You want to connect OpenClaw to QQ
  - You need QQ Bot credential or QR-code setup
  - You want QQ Bot group or private chat support
title: QQ bot
---

QQ Bot connects OpenClaw to QQ through the official QQ Bot API. It supports C2C
private chats, group chats, rich media, and WebSocket or Webhook transport.

Status: external plugin maintained by the Tencent Connect team. The plugin code
and release lifecycle live in the
[tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)
repository, outside the OpenClaw core repository.

## Install

```bash
openclaw plugins install @tencent-connect/openclaw-qqbot@latest
```

## Migrate from the former bundled plugin

The external plugin keeps the `qqbot` channel id and existing `appId` /
`clientSecret` string settings. It does not currently consume OpenClaw's
structured SecretRef objects. Before upgrading a configuration that stores
`clientSecret` as a SecretRef, move the value to one of the environment variables
supported by the external plugin: `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET`.

Then remove the structured `clientSecret` value from `channels.qqbot`, install
the external package, and restart the Gateway. Plain string credentials continue
to work without this migration.

## Setup with QR login

The plugin supports QR-code binding, so you do not need to copy credentials
manually:

```bash
openclaw channels login --channel qqbot
```

You can also run `openclaw onboard`. Scan the terminal QR code with the phone QQ
account associated with the target bot, then restart the Gateway if it is already
running.

## Setup with AppID and AppSecret

1. Open the [QQ Open Platform](https://q.qq.com/), sign in, and create a bot.
2. Copy the bot's **AppID** and **AppSecret**.
3. Add the channel:

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
openclaw gateway restart
```

Equivalent minimal config:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
    },
  },
}
```

The default account can also read `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET` from
the environment.

## Common configuration

Multiple bots can run under one OpenClaw instance:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "111111111",
      clientSecret: "secret-of-bot-1",
      accounts: {
        bot2: {
          enabled: true,
          appId: "222222222",
          clientSecret: "secret-of-bot-2",
        },
      },
    },
  },
}
```

Each account owns an independent QQ connection and token cache. Use
`--account bot2` when sending through a non-default bot.

By default the plugin uses WebSocket transport, which does not require a public
inbound endpoint. For deployments that need QQ HTTP callbacks, set
`transport: "webhook"` and configure the plugin's `webhook` settings. See the
upstream README for the current callback and signature configuration.

Group chats require an `@` mention by default. The external plugin also supports
per-group trigger rules, tool policies, prompts, and an autonomous response mode.

## Target formats

| Format                     | Description        |
| -------------------------- | ------------------ |
| `qqbot:c2c:OPENID`         | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat         |
| `qqbot:channel:CHANNEL_ID` | Guild channel      |

Each bot has its own set of user OpenIDs. An OpenID received by one bot cannot
be used to send through another bot.

## Troubleshooting

- If the plugin is missing, run `openclaw plugins install
@tencent-connect/openclaw-qqbot@latest` and restart the Gateway.
- If inbound messages do not arrive, verify that the bot is enabled on the QQ
  Open Platform and that its AppID/AppSecret belong to the same bot.
- If QR login cannot complete, use the AppID/AppSecret setup path above.
- QQ can restrict proactive messages when the user has not interacted with the
  bot recently.

Plugin-specific configuration and behavior can change independently of
OpenClaw core. For the complete and current reference, see the
[external plugin README](https://github.com/tencent-connect/openclaw-qqbot#readme).

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel troubleshooting](/channels/troubleshooting)
