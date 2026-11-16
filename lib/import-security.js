const { createHmac, timingSafeEqual } = require('node:crypto');

const SESSION_TTL = 86400;
const isSession = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isMessageId = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value);

function signDownload(fileId, session, secret, now = Date.now()) {
  if (!secret || !isSession(session) || typeof fileId !== 'string' || !fileId) throw new Error('Invalid download capability');
  const payload = Buffer.from(JSON.stringify({ fileId, session, expires: now + 15 * 60 * 1000 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyDownload(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!isSession(data.session) || typeof data.fileId !== 'string' || !data.fileId ||
        !Number.isFinite(data.expires) || data.expires <= now) return null;
    return data;
  } catch { return null; }
}

function validWebhookSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { SESSION_TTL, isSession, isMessageId, signDownload, verifyDownload, validWebhookSecret };
