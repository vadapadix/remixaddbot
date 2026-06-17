const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL, {
  family: 4, // Force IPv4, Vercel sometimes has issues with IPv6 routing to Redis
  connectTimeout: 10000,
});

redis.on('error', (err) => console.error('Redis Client Error', err));

module.exports = async (req, res) => {
  // Allow CORS for the desktop app if necessary, though desktop apps ignore CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }

  try {
    const sessionKey = `session:${sessionId}`;
    const songsData = await redis.get(sessionKey);
    let songs = [];
    if (songsData) {
        try {
            songs = JSON.parse(songsData);
        } catch(e) {}
    }

    if (!songs || songs.length === 0) {
      return res.status(200).json({ songs: [] });
    }

    // We have songs! Before returning them to the client, 
    // let's get the direct download links from Telegram if the client needs them.
    // The Desktop app needs to download the file. 
    // It can use the Telegram Bot API `getFile` method itself IF it has the Bot Token, 
    // BUT we don't want to expose the Bot Token in the desktop app.
    // So the serverless function will resolve the file_id to a direct URL.

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    // Resolve file_ids to download URLs
    const resolvedSongs = await Promise.all(songs.map(async (song) => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${song.file_id}`);
        const data = await response.json();
        
        if (data.ok) {
          song.download_url = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
        }
      } catch (err) {
        console.error('Error fetching file path from Telegram:', err);
      }
      return song;
    }));

    // Clear the songs from the KV store so we don't download them twice
    await redis.del(sessionKey);

    return res.status(200).json({ songs: resolvedSongs });
  } catch (error) {
    console.error('Error in getData:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
