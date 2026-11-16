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
      const urlFor = fileId => `${baseUrl}/api/download?token=${encodeURIComponent(signDownload(fileId, session, secret))}`;
      // Whitelist output fields: never return a stored URL, credential or provider error.
      return res.status(200).json({ songs: songs.map(song => ({
        id: song.id, title: song.title, performer: song.performer, duration: song.duration,
        file_name: song.file_name, file_size: song.file_size, mime_type: song.mime_type,
        download_url: urlFor(song.file_id), thumb_url: song.thumb_file_id ? urlFor(song.thumb_file_id) : ''
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

function createDownload({ secret, fetchFile = fetch }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const capability = verifyDownload(req.query?.token, secret);
    if (!capability) return res.status(401).json({ error: 'Invalid download capability' });
    try {
      const metadata = await fetchFile(`https://api.telegram.org/bot${secret}/getFile?file_id=${encodeURIComponent(capability.fileId)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!metadata.ok) throw new Error('Metadata unavailable');
      const info = await metadata.json();
      const path = info.result?.file_path;
      if (!info.ok || typeof path !== 'string' || !/^[\w/.-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid file path');
      const file = await fetchFile(`https://api.telegram.org/file/bot${secret}/${path}`, { signal: AbortSignal.timeout(120000), redirect: 'error' });
      if (!file.ok || !file.body) throw new Error('File unavailable');
      res.setHeader('Content-Type', 'application/octet-stream');
      if (file.headers.get('content-length')) res.setHeader('Content-Length', file.headers.get('content-length'));
      await pipeline(Readable.fromWeb(file.body), res);
    } catch {
      if (!res.headersSent) return res.status(502).json({ error: 'File temporarily unavailable' });
      res.destroy();
    }
  };
}
module.exports = { createGetData, createAck, createDownload };
