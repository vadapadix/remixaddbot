// Self-diagnosis (and optional self-heal) for the Telegram webhook.
// GET /api/health        -> webhook registration status, safe fields only
// GET /api/health?fix=1  -> when the webhook is missing or points elsewhere,
//                           (re)register it against PUBLIC_BASE_URL, then re-report.
// Secrets never appear in the response: only booleans, hosts and Telegram's own
// getWebhookInfo diagnostic fields.

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function requireEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) throw Object.assign(new Error('TELEGRAM_BOT_TOKEN is not configured'), { status: 503 });
  if (!secret || !WEBHOOK_SECRET_PATTERN.test(secret)) {
    throw Object.assign(new Error('TELEGRAM_WEBHOOK_SECRET is missing or malformed (32-256 URL-safe characters)'), { status: 503 });
  }
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://remix-telegram-bot.vercel.app';
  if (!/^https:\/\/[\w.-]+(?::\d+)?$/.test(baseUrl)) {
    throw Object.assign(new Error('PUBLIC_BASE_URL must be an HTTPS origin'), { status: 503 });
  }
  return { token, secret, baseUrl, expected: new URL('/api/webhook', baseUrl).href };
}

async function telegram(token, method, body) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({ ok: false }));
  if (!data.ok) throw Object.assign(new Error('telegram ' + method + ' failed'), { status: 502, telegramCode: data.error_code });
  return data.result;
}

function summarize(info, expected) {
  let host = '';
  try { host = new URL(info.url).host; } catch { }
  return {
    configured: !!info.url,
    webhookHost: host,
    matchesPublicBase: !!info.url && info.url === expected,
    pendingUpdates: info.pending_update_count || 0,
    lastErrorDate: info.last_error_date || null,
    lastHttpError: (info.last_error_message || '').match(/\b(?:401|403|404|500|502|503|504)\b/)?.[0] || null,
    lastErrorMessage: info.last_error_message || null,
    allowedUpdates: info.allowed_updates || []
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  let config;
  try { config = requireEnv(); }
  catch (error) { res.status(error.status || 503).json({ ok: false, reason: error.message }); return; }
  try {
    let info = await telegram(config.token, 'getWebhookInfo');
    let fixed = false;
    if (req.query && req.query.fix === '1' && (!info.url || info.url !== config.expected)) {
      await telegram(config.token, 'setWebhook', {
        url: config.expected,
        secret_token: config.secret,
        allowed_updates: ['message', 'channel_post'],
        drop_pending_updates: false
      });
      info = await telegram(config.token, 'getWebhookInfo');
      fixed = true;
    }
    let botUsername = null;
    try { botUsername = (await telegram(config.token, 'getMe')).username || null; } catch { }
    res.status(200).json({ ok: true, fixed, botUsername, expectedWebhookUrl: config.expected, ...summarize(info, config.expected) });
  } catch (error) {
    res.status(error.status || 503).json({ ok: false, reason: 'Telegram API unreachable from this deployment', code: error.telegramCode || null });
  }
};
