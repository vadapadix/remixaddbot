const { Telegraf } = require('telegraf');
const Redis = require('ioredis');

function getRedisUrl() {
  const direct = process.env.KV_REDIS_URL ||
                 process.env.REDIS_URL || 
                 process.env.KV_URL || 
                 process.env.STORAGE_URL || 
                 process.env.STORAGE_REDIS_URL || 
                 process.env.UPSTASH_REDIS_URL;
  if (direct) return direct;

  // Auto-detect any environment variable starting with redis:// or rediss://
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && (value.startsWith('redis://') || value.startsWith('rediss://'))) {
      console.log(`Auto-detected Redis URL in process.env.${key}`);
      return value;
    }
  }
  return null;
}

const redisUrl = getRedisUrl();

let redis = null;
if (redisUrl) {
  try {
    redis = new Redis(redisUrl, {
      family: 4, // Force IPv4
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) return null; // Stop reconnecting after 2 attempts
        return 1000;
      },
    });

    redis.on('error', (err) => {
      console.error('Redis Client Error:', err.message);
    });
  } catch (err) {
    console.error('Failed to initialize Redis client:', err.message);
  }
} else {
  console.warn('REDIS_URL or KV_URL environment variable is not defined.');
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// Helper to check redis before command execution
function checkRedis(ctx) {
  if (!redis) {
    ctx.reply('⚠️ База даних Redis не налаштована або недоступна на сервері. Перевірте REDIS_URL у налаштуваннях Vercel.');
    return false;
  }
  return true;
}

// Handle /start command with payload (e.g., /start 1167)
bot.start(async (ctx) => {
  const sessionId = ctx.startPayload; // The '1167' part in t.me/remixbot?start=1167
  const chatId = ctx.chat.id;
  
  if (!checkRedis(ctx)) return;

  if (sessionId) {
    try {
      // Save the mapping from this user's chat to the desktop session ID
      await redis.set(`chat:${chatId}`, sessionId);
      // Remember the latest active session for channel linking
      await redis.set(`last-user-session`, sessionId);
      await ctx.reply(`✅ Зв'язок встановлено! (Сесія: ${sessionId})\n\nТепер просто відправте або перешліть мені пісні (аудіо файли), і я передам їх у застосунок REMIX.\n\nДля підключення каналу: /linkchannel`);
    } catch (err) {
      console.error('Redis error in /start:', err.message);
      await ctx.reply('❌ Помилка збереження сесії в Redis. Перевірте з\'єднання з базою даних.');
    }
  } else {
    await ctx.reply('Привіт! Я бот для застосунку REMIX. Щоб підключити мене, використайте посилання безпосередньо з додатку.');
  }
});

// Handle /linkchannel command — link a Telegram channel to a REMIX session
bot.command('linkchannel', async (ctx) => {
  if (!checkRedis(ctx)) return;
  const chatId = ctx.chat.id;
  try {
    const sessionId = await redis.get(`chat:${chatId}`);
    
    if (!sessionId) {
      return ctx.reply('❌ Спочатку підключіть бота через застосунок REMIX (зайдіть через посилання з додатку).');
    }
    
    await ctx.reply(
      '📡 Щоб підключити канал:\n\n' +
      '1. Додайте цього бота як адміністратора до каналу\n' +
      '2. Надішліть /confirmchannel з каналу\n\n' +
      'Бот автоматично почне отримувати аудіо з підключеного каналу.'
    );
  } catch (err) {
    console.error('Redis error in /linkchannel:', err.message);
    await ctx.reply('❌ Помилка зв\'язку з базою даних.');
  }
});

// Handle /confirmchannel — called from the channel itself to link it
bot.command('confirmchannel', async (ctx) => {
  if (!checkRedis(ctx)) return;
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  
  if (chatType !== 'channel') {
    return ctx.reply('❌ Ця команда повинна бути надіслана з каналу.');
  }
  
  try {
    const activeSession = await redis.get(`last-user-session`);
    if (!activeSession) {
      return ctx.reply('❌ Не знайдено активну сесію REMIX. Спочатку підключіть бота в приватному чаті.');
    }
    
    await redis.set(`channel:${chatId}`, activeSession);
    await redis.set(`channel-session:${chatId}`, activeSession);
    
    try {
      await ctx.telegram.sendMessage(
        parseInt(activeSession.split('-')[0]), 
        '📡 Канал успішно підключено! Аудіо з каналу буде автоматично імпортуватись.'
      );
    } catch(e) {}
  } catch (err) {
    console.error('Redis error in /confirmchannel:', err.message);
  }
});

// Handle channel posts with audio (bot added as admin to channel)
bot.on('channel_post', async (ctx) => {
  if (!redis) return;
  const channelPost = ctx.channelPost;
  if (!channelPost?.audio) return;
  
  const chatId = ctx.chat.id;
  try {
    let sessionId = await redis.get(`channel:${chatId}`);
    if (!sessionId) return;
    
    const audio = channelPost.audio;
    const songData = {
      file_id: audio.file_id,
      title: audio.title || 'Невідома назва',
      performer: audio.performer || 'Невідомий виконавець',
      duration: audio.duration,
      mime_type: audio.mime_type,
      file_name: audio.file_name,
      file_size: audio.file_size,
      thumb_file_id: audio.thumb?.file_id || null,
      source: 'telegram_channel',
      timestamp: Date.now()
    };
    
    const sessionKey = `session:${sessionId}`;
    let songsData = await redis.get(sessionKey);
    let songs = [];
    if (songsData) {
      try { songs = JSON.parse(songsData); } catch(e) {}
    }
    
    songs.push(songData);
    await redis.set(sessionKey, JSON.stringify(songs), 'EX', 86400);
  } catch (err) {
    console.error('Redis error in channel_post:', err.message);
  }
});

// Handle incoming audio files (direct messages and forwards)
bot.on('audio', async (ctx) => {
  if (!checkRedis(ctx)) return;
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  
  try {
    let sessionId;
    if (chatType === 'channel') {
      sessionId = await redis.get(`channel:${chatId}`);
      if (!sessionId) {
        sessionId = await redis.get(`channel-session:${chatId}`);
      }
    } else {
      sessionId = await redis.get(`chat:${chatId}`);
    }
    
    if (!sessionId) {
      return ctx.reply('❌ Спочатку підключіть бота через застосунок REMIX.');
    }
    
    const audio = ctx.message?.audio || ctx.channelPost?.audio;
    if (!audio) return;
    
    const songData = {
      file_id: audio.file_id,
      title: audio.title || 'Невідома назва',
      performer: audio.performer || 'Невідомий виконавець',
      duration: audio.duration,
      mime_type: audio.mime_type,
      file_name: audio.file_name,
      file_size: audio.file_size,
      thumb_file_id: audio.thumb?.file_id || null,
      source: chatType === 'channel' ? 'telegram_channel' : 'telegram',
      timestamp: Date.now()
    };
    
    const sessionKey = `session:${sessionId}`;
    let songsData = await redis.get(sessionKey);
    let songs = [];
    if (songsData) {
      try {
        songs = JSON.parse(songsData);
      } catch(e) {}
    }
    
    songs.push(songData);
    await redis.set(sessionKey, JSON.stringify(songs), 'EX', 86400);
    
    await ctx.reply(`🎵 Трек "${songData.performer} - ${songData.title}" успішно відправлено в REMIX!`);
  } catch (err) {
    console.error('Redis error in audio handler:', err.message);
    await ctx.reply('❌ Не вдалося зберегти трек. Перевірте з\'єднання з базою даних Redis.');
  }
});

// For Vercel Serverless Function
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body);
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
};
