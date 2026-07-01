const { Telegraf } = require('telegraf');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL, {
  family: 4, // Force IPv4
  connectTimeout: 10000,
});

redis.on('error', (err) => console.error('Redis Client Error', err));

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Handle /start command with payload (e.g., /start 1167)
bot.start(async (ctx) => {
  const sessionId = ctx.startPayload; // The '1167' part in t.me/remixbot?start=1167
  const chatId = ctx.chat.id;
  
  if (sessionId) {
    // Save the mapping from this user's chat to the desktop session ID
    await redis.set(`chat:${chatId}`, sessionId);
    // Remember the latest active session for channel linking
    await redis.set(`last-user-session`, sessionId);
    await ctx.reply(`✅ Зв'язок встановлено! (Сесія: ${sessionId})\n\nТепер просто відправте або перешліть мені пісні (аудіо файли), і я передам їх у застосунок REMIX.\n\nДля підключення каналу: /linkchannel`);
  } else {
    await ctx.reply('Привіт! Я бот для застосунку REMIX. Щоб підключити мене, використайте посилання безпосередньо з додатку.');
  }
});

// Handle /linkchannel command — link a Telegram channel to a REMIX session
bot.command('linkchannel', async (ctx) => {
  const chatId = ctx.chat.id;
  const sessionId = await redis.get(`chat:${chatId}`);
  
  if (!sessionId) {
    return ctx.reply('❌ Спочатку підключіть бота через застосунок REMIX (зайдіть через посилання з додатку).');
  }
  
  // To link a channel, the bot must be added as admin to the channel
  // The user should forward a message from the channel to this chat
  await ctx.reply(
    '📡 Щоб підключити канал:\n\n' +
    '1. Додайте цього бота як адміністратора до каналу\n' +
    '2. Надішліть /confirmchannel з каналу\n\n' +
    'Бот автоматично почне отримувати аудіо з підключеного каналу.'
  );
});

// Handle /confirmchannel — called from the channel itself to link it
bot.command('confirmchannel', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  
  if (chatType !== 'channel') {
    return ctx.reply('❌ Ця команда повинна бути надіслана з каналу.');
  }
  
  // Look for any active user session to link this channel to
  // The user who added the bot should have an active session
  const activeSession = await redis.get(`last-user-session`);
  if (!activeSession) {
    return ctx.reply('❌ Не знайдено активну сесію REMIX. Спочатку підключіть бота в приватному чаті.');
  }
  
  await redis.set(`channel:${chatId}`, activeSession);
  await redis.set(`channel-session:${chatId}`, activeSession);
  // Also notify the user
  try {
    await ctx.telegram.sendMessage(
      parseInt(activeSession.split('-')[0]), 
      '📡 Канал успішно підключено! Аудіо з каналу буде автоматично імпортуватись.'
    );
  } catch(e) {}
});

// Handle channel posts with audio (bot added as admin to channel)
bot.on('channel_post', async (ctx) => {
  const channelPost = ctx.channelPost;
  if (!channelPost?.audio) return; // Only process audio posts
  
  const chatId = ctx.chat.id;
  let sessionId = await redis.get(`channel:${chatId}`);
  
  if (!sessionId) return; // Channel not linked — skip silently
  
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
});

// Handle incoming audio files (direct messages and forwards)
bot.on('audio', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type; // "private", "group", "supergroup", "channel"
  
  // For channels, use the channel ID directly; for private chats, look up session
  let sessionId;
  if (chatType === 'channel') {
    // Channels: allow any linked session via channel mapping
    sessionId = await redis.get(`channel:${chatId}`);
    if (!sessionId) {
      // Fall back to any session that subscribed to this channel
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
