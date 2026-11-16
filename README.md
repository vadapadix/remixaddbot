# REMIX Telegram import backend

Node.js 20+, Vercel functions and Redis over TLS. This directory is a separate Git submodule.

## Protocol

1. Desktop generates a cryptographically random 256-bit session (64 hexadecimal characters) and opens the bot deep link.
2. `/start` pairs the private chat with that session for 24 hours. A session cannot be claimed by a second chat.
3. Webhook enqueues messages atomically in a Redis hash; message IDs and expiring deduplication keys make webhook retries idempotent.
4. Desktop polls `GET /api/getData` with `Authorization: Bearer <session>`. Polling does not remove messages.
5. The response contains 15-minute signed `/api/download?token=...` URLs. The server streams Telegram files; the Telegram bot credential never appears in client responses or redirects.
6. After importing a track, desktop sends `POST /api/ack`, the same bearer header, and JSON `{ "ids": ["chatId:messageId"] }`. Only selected messages are removed.

Queue/deduplication retention is 24 hours. This is retryable, at-least-once delivery; durable exactly-once insertion into the desktop library is not claimed. Old 8-character sessions and legacy Redis arrays are not read by the new protocol: reconnect and resend pending files during migration.

Channel pairing uses an explicit session-bearing `/confirmchannel` command obtained in the owner's private chat. There is no global last-user mapping. Treat pairing commands as credentials.

## Deployment requirements

- `TELEGRAM_BOT_TOKEN`: server-only bot credential.
- `TELEGRAM_WEBHOOK_SECRET`: independent random secret. Configure Telegram's webhook with the same `secret_token`; the server rejects a missing or incorrect `X-Telegram-Bot-Api-Secret-Token` header.
- `REDIS_URL` or one of the Redis URL variables supported by `lib/redis.js`. Use trusted TLS certificates; certificate validation stays enabled.
- `PUBLIC_BASE_URL`: public HTTPS origin without trailing slash, for example `https://remix-telegram-bot.vercel.app`. It must match the deployment trusted by the desktop client.

Install dependencies with `npm install` in this directory and deploy the updated functions together. No deployment or webhook reconfiguration is performed by source changes. If an earlier deployed version returned Telegram credential-bearing file URLs, rotate the bot token after closing that exposure and update the server environment.

Deploy this backend together with the desktop protocol update. Confirm webhook delivery, real Redis Lua enqueue/dedup/ack, and file streaming before publishing the client. Verify your hosting plan's body/streaming limits and function timeouts for large audio; use an appropriate streaming host if necessary. Do not replace the proxy with a redirect to Telegram file URLs.

## Tests

From the parent REMIX repository:

```powershell
node --test Tests/telegram/import.test.cjs
```

These tests exercise injected HTTP handlers, signatures and acknowledgement behavior without production credentials, Redis or Telegram. A live Redis/deployment smoke check is still required before release.
