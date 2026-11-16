const { validWebhookSecret } = require('./import-security');

function createWebhookHandler({ handleUpdate, config = () => process.env, logger = console }) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('Method not allowed');
    }
    const env = config();
    const missing = ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN'].filter(key => !env[key]);
    if (missing.length) {
      logger.error('Telegram webhook configuration missing', { keys: missing });
      return res.status(503).send('Webhook is not configured');
    }
    if (!validWebhookSecret(req.headers?.['x-telegram-bot-api-secret-token'], env.TELEGRAM_WEBHOOK_SECRET)) {
      logger.warn('Telegram webhook rejected: invalid secret');
      return res.status(401).send('Unauthorized');
    }
    if (!req.body || !Number.isSafeInteger(req.body.update_id) || req.body.update_id < 0) {
      logger.warn('Telegram webhook rejected: invalid update');
      return res.status(400).send('Invalid update');
    }
    logger.info('Telegram webhook accepted');
    try {
      await handleUpdate(req.body);
      return res.status(200).send('OK');
    } catch {
      // Never log provider exceptions, headers, update content or credential URLs.
      logger.error('Telegram update failed');
      return res.status(503).send('Retry later');
    }
  };
}
module.exports = { createWebhookHandler };
