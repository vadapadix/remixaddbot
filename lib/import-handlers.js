const { isSession, isMessageId, signDownload, verifyDownload } = require('./import-security');
const { pending, acknowledge } = require('./import-queue');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function sessionFrom(req) {
  // New clients keep credentials out of query strings and request URL logs.
  const auth = req.headers?.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function createGetData({ redis, secret, baseUrl }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const session = sessionFrom(req);
    if (!isSession(session)) return res.status(401).json({ error: 'Invalid session' });
    if (!secret) return res.status(503).json({ error: 'Import is not configured' });
    try {
      const songs = await pending(redis, session);
      const urlFor = (fileId, filePath) => `${baseUrl}/api/download?token=${encodeURIComponent(signDownload(fileId, session, secret, Date.now(), filePath))}`;
      // Whitelist output fields: never return a stored URL, credential or provider error.
      return res.status(200).json({ songs: songs.map(song => ({
        id: song.id, title: song.title, performer: song.performer, duration: song.duration,
        file_name: song.file_name, file_size: song.file_size, mime_type: song.mime_type,
        download_url: urlFor(song.file_id, song.file_path), thumb_url: song.thumb_file_id ? urlFor(song.thumb_file_id, song.file_path) : ''
      })) });
    } catch { return res.status(503).json({ error: 'Import temporarily unavailable' }); }
  };
}

function createAck({ redis }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const session = sessionFrom(req);
    if (!isSession(session)) return res.status(401).json({ error: 'Invalid session' });
    try {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every(isMessageId))
        return res.status(400).json({ error: 'Invalid acknowledgement' });
      await acknowledge(redis, session, ids);
      return res.status(200).json({ ok: true });
    } catch { return res.status(503).json({ error: 'Acknowledgement temporarily unavailable' }); }
  };
}

const PATH_PATTERN = /^[\w/.-]+$/;

function createDownload({ secret, redis, fetchFile = fetch }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const capability = verifyDownload(req.query?.token, secret);
    if (!capability) return res.status(401).json({ error: 'Invalid download capability' });
    try {
      // Resolve the file path without getFile whenever possible: the signed token may
      // carry the path resolved at enqueue time, and Redis caches every fresh resolve.
      // getFile is rate-limited by Telegram; retry storms must never hammer it.
      const cacheKey = `dlpath:${capability.fileId}`;
      let path = typeof capability.filePath === 'string' && PATH_PATTERN.test(capability.filePath)
        ? capability.filePath : '';
      if (!path && redis) {
        try { path = (await redis.get(cacheKey)) || ''; } catch { }
        if (!PATH_PATTERN.test(path)) path = '';
      }
      let usedLiveMetadata = false;
      if (!path) {
        const metadata = await fetchFile(`https://api.telegram.org/bot${secret}/getFile?file_id=${encodeURIComponent(capability.fileId)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!metadata.ok) throw Object.assign(new Error('Metadata unavailable'), { stage: 'metadata' });
        const info = await metadata.json();
        path = info.result?.file_path || '';
        if (!info.ok || !PATH_PATTERN.test(path) || path.split('/').includes('..')) throw Object.assign(new Error('Invalid file path'), { stage: 'metadata' });
        usedLiveMetadata = true;
        if (redis) { try { await redis.set(cacheKey, path, 'EX', 3300); } catch { } }
      }
      try {
        return await streamFile(req, res, secret, path, fetchFile);
      } catch (error) {
        if (!error || !error.stalePath || usedLiveMetadata) throw error;
        // The stored/cached path expired (Telegram rotates them about hourly):
        // resolve fresh metadata once and retry the stream.
        const metadata = await fetchFile(`https://api.telegram.org/bot${secret}/getFile?file_id=${encodeURIComponent(capability.fileId)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!metadata.ok) throw Object.assign(new Error('Metadata unavailable'), { stage: 'metadata' });
        const info = await metadata.json();
        path = info.result?.file_path || '';
        if (!info.ok || !PATH_PATTERN.test(path) || path.split('/').includes('..')) throw Object.assign(new Error('Invalid file path'), { stage: 'metadata' });
        if (redis) { try { await redis.set(cacheKey, path, 'EX', 3300); } catch { } }
        return await streamFile(req, res, secret, path, fetchFile);
      }
    } catch (error) {
      const reason = error && error.stage ? `Telegram ${error.stage} unavailable` : 'File temporarily unavailable';
      if (!res.headersSent) return res.status(502).json({ error: reason });
      res.destroy();
    }
  };
}

async function streamFile(req, res, secret, path, fetchFile) {
  // Range passthrough: the desktop fetches big files in bounded windows so every
  // function invocation stays well inside the platform timeout (a whole-file
  // stream of a large audio file hits the serverless timeout -> 502 mid-transfer).
  const fetchOptions = { signal: AbortSignal.timeout(120000), redirect: 'error' };
  const rangeHeader = typeof req.headers?.range === 'string' ? req.headers.range.trim() : '';
  const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  let partial = false;
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    let end = rangeMatch[2] !== '' ? parseInt(rangeMatch[2], 10) : start + 8 * 1024 * 1024 - 1;
    if (!Number.isSafeInteger(end) || end < start) end = start + 8 * 1024 * 1024 - 1;
    // Bound the served window even for unbounded client ranges: an 8 MiB slice
    // streams comfortably inside any plan timeout.
    if (end - start + 1 > 8 * 1024 * 1024) end = start + 8 * 1024 * 1024 - 1;
    fetchOptions.headers = { range: `bytes=${start}-${end}` };
    partial = true;
  }
  const file = await fetchFile(`https://api.telegram.org/file/bot${secret}/${path}`, fetchOptions);
  if (!file.ok || !file.body) throw Object.assign(new Error('File unavailable'), { stalePath: true });
  res.setHeader('Content-Type', 'application/octet-stream');
  const contentRange = file.headers.get('content-range');
  if (contentRange) res.setHeader('Content-Range', contentRange);
  res.setHeader('Accept-Ranges', 'bytes');
  if (partial && file.status === 206) {
    // Telegram honoured the range: mirror its partial body verbatim.
    if (file.headers.get('content-length')) res.setHeader('Content-Length', file.headers.get('content-length'));
    res.statusCode = 206;
    await pipeline(Readable.fromWeb(file.body), res);
    return;
  }
  if (!partial) {
    if (file.headers.get('content-length')) res.setHeader('Content-Length', file.headers.get('content-length'));
    await pipeline(Readable.fromWeb(file.body), res);
    return;
  }
  // Telegram ignored the Range (200 with the whole body): slice the requested
  // window locally — skip `start` bytes, send exactly end-start+1, then stop
  // pulling upstream. Every invocation now delivers a correct window no matter
  // what the upstream supports, so big files download in bounded chunks.
  const start = parseInt(rangeMatch[1], 10);
  const end = rangeMatch[2] !== '' ? parseInt(rangeMatch[2], 10) : start + 8 * 1024 * 1024 - 1;
  const sliceLength = end - start + 1;
  const declaredLength = parseInt(file.headers.get('content-length') || '0', 10);
  res.setHeader('Content-Length', String(sliceLength));
  res.setHeader('Content-Range', `bytes ${start}-${end}/${declaredLength > 0 ? declaredLength : '*'}`);
  res.statusCode = 206;
  let skipped = 0;
  let sent = 0;
  await pipeline(Readable.fromWeb(file.body), async function* (source) {
    for await (const chunk of source) {
      if (sent >= sliceLength) return;
      let payload = chunk;
      if (skipped < start) {
        const toSkip = Math.min(start - skipped, payload.length);
        skipped += toSkip;
        payload = payload.subarray(toSkip);
        if (payload.length === 0) continue;
      }
      const remaining = sliceLength - sent;
      if (payload.length > remaining) payload = payload.subarray(0, remaining);
      sent += payload.length;
      yield payload;
    }
  }, res);
}
module.exports = { createGetData, createAck, createDownload };
