const { getRedis } = require('../lib/redis');
const { createGetData } = require('../lib/import-handlers');

module.exports = async (req, res) => {
  try {
    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://remix-telegram-bot.vercel.app';
    if (!/^https:\/\/[\w.-]+(?::\d+)?$/.test(baseUrl)) throw new Error('Invalid public URL');
    return await createGetData({ redis: getRedis(), secret: process.env.TELEGRAM_BOT_TOKEN, baseUrl })(req, res);
  } catch { return res.status(503).json({ error: 'Import temporarily unavailable' }); }
};
