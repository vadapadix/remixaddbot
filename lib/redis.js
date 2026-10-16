const Redis = require('ioredis');

let client;
function getRedis() {
  if (client) return client;
  const url = ['KV_REDIS_URL', 'REDIS_URL', 'KV_URL', 'STORAGE_URL', 'STORAGE_REDIS_URL', 'UPSTASH_REDIS_URL']
    .map(name => process.env[name]).find(value => /^rediss?:\/\//.test(value || ''));
  if (!url) throw new Error('Redis is not configured');
  // Keep TLS certificate verification enabled. Never log the connection URL.
  client = new Redis(url, { family: 4, connectTimeout: 10000, maxRetriesPerRequest: 1 });
  client.on('error', () => console.error('Redis connection failed'));
  return client;
}
module.exports = { getRedis };
