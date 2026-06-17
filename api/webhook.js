const { Telegraf } = require('telegraf');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Handle /start command with payload (e.g., /start 1167)
bot.start(async (ctx) => {
  const sessionId = ctx.startPayload; // The '1167' part in t.me/remixbot?start=1167
  const chatId = ctx.chat.id;
  
  if (sessionId) {
    // Save the mapping from this user's chat to the desktop session ID
    await redis.set(`chat:${chatId}`, sessionId);
    await ctx.reply(`✅ Зв'язок встановлено! (Сесія: ${sessionId})\n\nТепер просто відправте або перешліть мені пісні (аудіо файли), і я передам їх у застосунок REMIX.`);
  } else {
    await ctx.reply('Привіт! Я бот для застосунку REMIX. Щоб підключити мене, використайте посилання безпосередньо з додатку.');
  }
});

// Handle incoming audio files
bot.on('audio', async (ctx) => {
  const chatId = ctx.chat.id;
  
  // Get the session ID for this chat
  const sessionId = await redis.get(`chat:${chatId}`);
  
  if (!sessionId) {
    return ctx.reply('❌ Спочатку підключіть бота через застосунок REMIX.');
  }
  
  const audio = ctx.message.audio;
  const songData = {
    file_id: audio.file_id,
    title: audio.title || 'Невідома назва',
    performer: audio.performer || 'Невідомий виконавець',
    duration: audio.duration,
    mime_type: audio.mime_type,
    file_name: audio.file_name,
    file_size: audio.file_size,
    timestamp: Date.now()
  };
  
  // Get existing songs for this session
  const sessionKey = `session:${sessionId}`;
  let songsData = await redis.get(sessionKey);
  let songs = [];
  if (songsData) {
    try {
      songs = JSON.parse(songsData);
    } catch(e) {}
  }
  
  // Add new song
  songs.push(songData);
  
  // Save back to KV store
  await redis.set(sessionKey, JSON.stringify(songs), 'EX', 86400); // Expire in 24 hours
  
  await ctx.reply(`🎵 Трек "${songData.performer} - ${songData.title}" успішно відправлено в REMIX!`);
});

// For Vercel Serverless Function
module.exports = async (req, res) => {
  try {
    // Only process POST requests (Telegram Webhooks are POST)
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
};
