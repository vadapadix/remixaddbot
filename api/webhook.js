const { Telegraf } = require('telegraf');
const { getRedis } = require('../lib/redis');
const { enqueue } = require('../lib/import-queue');
const { SESSION_TTL, isSession, validWebhookSecret } = require('../lib/import-security');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

bot.start(async ctx => {
  const session = ctx.startPayload;
  if (ctx.chat.type !== 'private' || !isSession(session))
    return ctx.reply('Відкрийте підключення Telegram із поточної версії REMIX.');
  const redis = getRedis();
  const ownerKey = `owner:${session}`;
  const owner = String(ctx.chat.id);
  await redis.set(ownerKey, owner, 'EX', SESSION_TTL, 'NX');
  if (await redis.get(ownerKey) !== owner) return ctx.reply('Ця сесія вже підключена до іншого користувача.');
  await redis.set(`chat:${ctx.chat.id}`, session, 'EX', SESSION_TTL);
  return ctx.reply('✅ REMIX підключено. Надішліть аудіо для імпорту. Для підключення каналу: /linkchannel');
});

bot.command('linkchannel', async ctx => {
  if (ctx.chat.type !== 'private') return;
  const session = await getRedis().get(`chat:${ctx.chat.id}`);
  if (!isSession(session)) return ctx.reply('Спочатку підключіть REMIX.');
  // Explicit capability replaces the global last-user-session cross-account mapping.
  return ctx.reply(`Додайте бота адміністратором каналу та надішліть у каналі команду:\n/confirmchannel ${session}\nНе передавайте цю команду стороннім.`);
});

bot.command('confirmchannel', async ctx => {
  if (ctx.chat.type !== 'channel') return ctx.reply('Надішліть команду з каналу.');
  const text = ctx.channelPost?.text || ctx.message?.text || '';
  const session = text.trim().split(/\s+/)[1];
  if (!isSession(session) || !await getRedis().get(`owner:${session}`))
    return ctx.reply('Отримайте нову команду через /linkchannel у приватному чаті.');
  await getRedis().set(`channel:${ctx.chat.id}`, session, 'EX', SESSION_TTL);
  return ctx.reply('✅ Канал підключено до REMIX.');
});

async function receiveAudio(ctx) {
  const audio = ctx.message?.audio || ctx.channelPost?.audio;
  if (!audio) return;
  const channel = ctx.chat.type === 'channel';
  const redis = getRedis();
  const session = await redis.get(`${channel ? 'channel' : 'chat'}:${ctx.chat.id}`);
  if (!isSession(session) || !await redis.get(`owner:${session}`)) {
    if (!channel) await ctx.reply('Спочатку підключіть REMIX.');
    return;
  }
  await enqueue(redis, session, `${ctx.chat.id}:${ctx.message?.message_id || ctx.channelPost?.message_id}`, {
    file_id: audio.file_id, title: audio.title || 'Невідома назва', performer: audio.performer || 'Невідомий виконавець',
    duration: audio.duration, mime_type: audio.mime_type, file_name: audio.file_name, file_size: audio.file_size,
    thumb_file_id: audio.thumbnail?.file_id || audio.thumb?.file_id || null, timestamp: Date.now()
  });
  if (!channel) await ctx.reply('🎵 Трек додано до черги REMIX.');
}
bot.on('channel_post', receiveAudio);
bot.on('audio', receiveAudio);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return res.status(503).send('Webhook is not configured');
  if (!validWebhookSecret(req.headers?.['x-telegram-bot-api-secret-token'], expected))
    return res.status(401).send('Unauthorized');
  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send('OK');
  } catch {
    // Provider exceptions may include credential-bearing URLs. Do not log them.
    console.error('Telegram update failed');
    return res.status(503).send('Retry later');
  }
};
