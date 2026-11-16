const { getRedis } = require('../lib/redis');
const { createDownload } = require('../lib/import-handlers');
module.exports = (req, res) => createDownload({ secret: process.env.TELEGRAM_BOT_TOKEN, redis: getRedis() })(req, res);
