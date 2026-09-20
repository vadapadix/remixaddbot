const Redis = require('ioredis');

function getRedisUrl() {
  const candidates = [
    { name: 'KV_REDIS_URL', val: process.env.KV_REDIS_URL },
    { name: 'REDIS_URL', val: process.env.REDIS_URL },
    { name: 'KV_URL', val: process.env.KV_URL },
    { name: 'STORAGE_URL', val: process.env.STORAGE_URL },
    { name: 'STORAGE_REDIS_URL', val: process.env.STORAGE_REDIS_URL },
    { name: 'UPSTASH_REDIS_URL', val: process.env.UPSTASH_REDIS_URL },
  ];

  for (const c of candidates) {
    if (c.val && (c.val.startsWith('redis://') || c.val.startsWith('rediss://'))) {
      console.log(`[REDIS] Using ${c.name}`);
      return c.val;
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && (value.startsWith('redis://') || value.startsWith('rediss://'))) {
      console.log(`[REDIS] Auto-detected Redis URL in process.env.${key}`);
      return value;
    }
  }
  return null;
}

const redisUrl = getRedisUrl();

let redis = null;
if (redisUrl) {
  try {
    const isTls = redisUrl.startsWith('rediss://');
    const parsed = new URL(redisUrl);
    console.log(`[REDIS] Target: ${parsed.protocol}//${parsed.username ? parsed.username + '@' : ''}${parsed.hostname}:${parsed.port}`);

    const redisOptions = {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      family: 4, // Force IPv4 on Vercel/Lambda to avoid IPv6 routing hang
      connectTimeout: 10000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy(times) {
        if (times > 2) return null;
        return 1000;
      },
    };

    if (parsed.pathname && parsed.pathname.length > 1) {
      const dbNum = parseInt(parsed.pathname.slice(1), 10);
      if (!isNaN(dbNum)) redisOptions.db = dbNum;
    }

    if (isTls) {
      redisOptions.tls = {
        rejectUnauthorized: false,
      };
    }

    redis = new Redis(redisOptions);

    redis.on('error', (err) => {
      console.error('Redis Client Error:', err.message);
    });
  } catch (err) {
    console.error('Failed to initialize Redis client:', err.message);
  }
} else {
  console.warn('No Redis URL environment variable found.');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }

  if (!redis) {
    return res.status(503).json({ 
      error: 'Redis database not configured', 
      details: 'Please set REDIS_URL in Vercel project environment variables.' 
    });
  }

  try {
    const sessionKey = `session:${sessionId}`;
    let songsData = null;
    try {
      songsData = await redis.get(sessionKey);
    } catch (redisErr) {
      console.error('Redis GET failed:', redisErr.message);
      return res.status(503).json({ 
        error: 'Database connection failed', 
        details: redisErr.message 
      });
    }

    let songs = [];
    if (songsData) {
      try {
        songs = JSON.parse(songsData);
      } catch(e) {}
    }

    if (!songs || songs.length === 0) {
      return res.status(200).json({ songs: [] });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    // Resolve file_ids to download URLs
    const resolvedSongs = await Promise.all(songs.map(async (song) => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${song.file_id}`);
        const data = await response.json();
        
        if (data.ok) {
          song.download_url = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
        } else {
          console.error(`Telegram API getFile failed for file_id ${song.file_id}:`, data);
          song.error = data.description || 'Unknown Telegram API error';
        }
      } catch (err) {
        console.error('Error fetching file path from Telegram:', err);
        song.error = err.message;
      }

      // Resolve thumbnail URL if present
      if (song.thumb_file_id) {
        try {
          const thumbResp = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${song.thumb_file_id}`);
          const thumbData = await thumbResp.json();
          if (thumbData.ok) {
            song.thumb_url = `https://api.telegram.org/file/bot${botToken}/${thumbData.result.file_path}`;
          }
        } catch (err) {
          console.error('Error fetching thumbnail from Telegram:', err);
        }
      }
      
      return song;
    }));

    // Clear the songs from the KV store so we don't download them twice
    try {
      await redis.del(sessionKey);
    } catch (delErr) {
      console.error('Redis DEL failed:', delErr.message);
    }

    return res.status(200).json({ songs: resolvedSongs });
  } catch (error) {
    console.error('Error in getData:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};
