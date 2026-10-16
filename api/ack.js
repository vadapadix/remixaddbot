const { getRedis } = require('../lib/redis');
const { createAck } = require('../lib/import-handlers');
module.exports = async (req, res) => {
  try { return await createAck({ redis: getRedis() })(req, res); }
  catch { return res.status(503).json({ error: 'Import temporarily unavailable' }); }
};
