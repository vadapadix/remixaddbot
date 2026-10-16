const { createDownload } = require('../lib/import-handlers');
module.exports = (req, res) => createDownload({ secret: process.env.TELEGRAM_BOT_TOKEN })(req, res);
