// Credentials come only from the process environment, never command-line arguments.
async function main() {
  const configure = process.argv.includes('--set');
  const required = configure ? ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL'] : ['TELEGRAM_BOT_TOKEN'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error('Missing configuration: ' + missing.join(', '));
  let expected;
  if (process.env.PUBLIC_BASE_URL) {
    const base = new URL(process.env.PUBLIC_BASE_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('PUBLIC_BASE_URL must be an HTTPS origin');
    expected = new URL('/api/webhook', base).href;
  }
  if (configure && !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET)) throw new Error('Webhook secret must contain 32-256 URL-safe characters');
  const method = configure ? 'setWebhook' : 'getWebhookInfo';
  const response = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify(configure ? { url: expected, secret_token: process.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'channel_post'], drop_pending_updates: false } : {})
  });
  const data = await response.json();
  if (!data.ok) { console.error(JSON.stringify({ ok: false, operation: method, status: response.status, code: data.error_code })); process.exitCode = 1; return; }
  if (configure) { console.log(JSON.stringify({ ok: true, operation: method })); return; }
  const info = data.result;
  let host = ''; try { host = new URL(info.url).host; } catch {}
  console.log(JSON.stringify({ configured: !!info.url, host, matchesPublicBase: expected ? info.url === expected : null,
    pendingUpdates: info.pending_update_count, lastErrorDate: info.last_error_date || null,
    lastHttpError: (info.last_error_message || '').match(/\b(?:401|403|404|500|502|503|504)\b/)?.[0] || null, allowedUpdates: info.allowed_updates || [] }, null, 2));
}
main().catch(error => {
  // Only our own validation errors are safe. Network errors can contain a bot URL.
  console.error(error.message.startsWith('Missing configuration:') || error.message.startsWith('PUBLIC_BASE_URL ') || error.message.startsWith('Webhook secret ') ? error.message : 'Webhook operation failed; check connectivity and server configuration.');
  process.exitCode = 1;
});
