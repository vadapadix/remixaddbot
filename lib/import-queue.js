const { SESSION_TTL, isSession, isMessageId } = require('./import-security');

// A hash field is an idempotency key. Enqueue and TTL refresh are atomic.
async function enqueue(redis, session, id, song) {
  if (!isSession(session) || !isMessageId(id)) throw new Error('Invalid import identity');
  await redis.eval(`
    if not redis.call('SET', KEYS[2], '1', 'EX', ARGV[3], 'NX') then return 0 end
    redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
    redis.call('EXPIRE', KEYS[1], ARGV[3])
    return 1`, 2, `imports:${session}`, `import-seen:${session}:${id}`, id, JSON.stringify({ ...song, id }), SESSION_TTL);
}

async function pending(redis, session) {
  if (!isSession(session)) throw new Error('Invalid session');
  const values = await redis.hvals(`imports:${session}`);
  return values.map(value => JSON.parse(value)).sort((a, b) => a.timestamp - b.timestamp).slice(0, 50);
}

async function acknowledge(redis, session, ids) {
  if (!isSession(session) || !Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every(isMessageId))
    throw new Error('Invalid acknowledgement');
  return redis.hdel(`imports:${session}`, ...ids);
}
module.exports = { enqueue, pending, acknowledge };
