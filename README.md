# REMIX Telegram Bot

Цей бот створений для того, щоб передавати аудіофайли з Telegram безпосередньо у десктопний застосунок REMIX. 
Він базується на Node.js та розгортається на Vercel (через Serverless Functions). Для зберігання тимчасових даних між запитами клієнта та телеграму використовується Upstash Redis.

## Як це працює?
1. Застосунок REMIX генерує унікальний ідентифікатор сесії (наприклад, `1167` або `GUID`).
2. Користувач переходить за посиланням: `https://t.me/YourRemixBot?start=1167`.
3. Застосунок REMIX починає опитувати API бота кожні 2-3 секунди за адресою: `https://your-vercel-app.vercel.app/api/getData?session=1167`.
4. Користувач натискає "Start" у боті та відправляє аудіофайли.
5. Бот отримує аудіофайли, витягує метадані та тимчасово зберігає їх у базі даних (Upstash Redis).
6. Коли клієнт REMIX здійснює черговий запит до `/api/getData`, він отримує список пісень разом з прямими посиланнями на завантаження, після чого дані видаляються з бази.

## Як розгорнути на Vercel

### Крок 1. Створення Telegram Бота
1. Знайдіть у Telegram бота [@BotFather](https://t.me/BotFather).
2. Напишіть йому `/newbot` і дотримуйтесь інструкцій, щоб отримати **Bot Token** (наприклад, `123456789:ABCdefGHIjkl...`).

### Крок 2. Підготовка Vercel
1. Зареєструйтесь або увійдіть на [Vercel](https://vercel.com).
2. Встановіть Vercel CLI (опціонально, але зручно): `npm i -g vercel`.
3. У папці з цим проєктом (`remix-telegram-bot`) відкрийте термінал та запустіть команду:
   ```bash
   vercel
   ```
4. Пройдіть процес ініціалізації (виберіть поточну папку, налаштування за замовчуванням).
5. Перейдіть у панель керування вашим проєктом на Vercel.

### Крок 3. Налаштування Бази Даних (Redis)
1. Оскільки ви вже маєте `REDIS_URL`, перейдіть у панелі проєкту Vercel до **Settings -> Environment Variables**.
2. Створіть змінну `REDIS_URL` та вставте туди вашу стрічку: `redis://default:KEs1...`.

### Крок 4. Додавання Bot Token
1. У панелі проєкту Vercel перейдіть до **Settings -> Environment Variables**.
2. Створіть нову змінну з назвою `TELEGRAM_BOT_TOKEN` і вставте туди токен від BotFather.

### Крок 5. Встановлення Webhook
Щоб Telegram знав, куди надсилати повідомлення вашому боту, потрібно зареєструвати вебхук.
Виконайте такий запит у браузері або через `curl`, підставивши свої дані:
```
https://api.telegram.org/bot<ВАШ_TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<ВАШ_ДОМЕН_НА_VERCEL>/api/webhook
```
*Замініть `<ВАШ_TELEGRAM_BOT_TOKEN>` на токен і `<ВАШ_ДОМЕН_НА_VERCEL>` на домен, який Vercel видав вашому проєкту (наприклад, `remix-bot.vercel.app`).*
Якщо все успішно, ви побачите відповідь `{"ok":true,"result":true,"description":"Webhook was set"}`.

## Як інтегрувати в клієнт C# (Avalonia)

У вашому клієнті C# (наприклад, по кліку "Додати з Telegram") ви можете використати наступний код:

```csharp
using System;
using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

public class TelegramImportService
{
    private readonly HttpClient _httpClient = new HttpClient();
    private const string VercelAppUrl = "https://remix-telegram-bot.vercel.app"; // Адреса вашого Vercel
    private const string BotUsername = "remixx_bot"; // Ваш Telegram бот

    public async Task StartImportFlowAsync()
    {
        // 1. Генеруємо унікальну сесію
        string sessionId = Guid.NewGuid().ToString().Substring(0, 8);
        
        // 2. Відкриваємо посилання у браузері користувача
        string telegramUrl = $"https://t.me/{BotUsername}?start={sessionId}";
        Process.Start(new ProcessStartInfo
        {
            FileName = telegramUrl,
            UseShellExecute = true
        });

        // 3. Починаємо поллінг даних кожні 3 секунди
        bool isImporting = true;
        while (isImporting)
        {
            await Task.Delay(3000);
            
            try
            {
                string apiUrl = $"{VercelAppUrl}/api/getData?session={sessionId}";
                var response = await _httpClient.GetAsync(apiUrl);
                
                if (response.IsSuccessStatusCode)
                {
                    string json = await response.Content.ReadAsStringAsync();
                    using var doc = JsonDocument.Parse(json);
                    
                    var songsElement = doc.RootElement.GetProperty("songs");
                    if (songsElement.GetArrayLength() > 0)
                    {
                        foreach (var song in songsElement.EnumerateArray())
                        {
                            string title = song.GetProperty("title").GetString();
                            string performer = song.GetProperty("performer").GetString();
                            string downloadUrl = song.GetProperty("download_url").GetString();
                            
                            Console.WriteLine($"Отримано: {performer} - {title}");
                            // TODO: Завантажити файл за downloadUrl та додати в плейлист REMIX
                            
                            // Завантаження файлу:
                            // byte[] audioData = await _httpClient.GetByteArrayAsync(downloadUrl);
                            // await File.WriteAllBytesAsync($"C:\\Music\\{performer} - {title}.mp3", audioData);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Помилка: {ex.Message}");
            }
        }
    }
}
```

## Додаткові зауваження
Обмеження Telegram Bot API на розмір файлу для завантаження становить 20 МБ. Більшість пісень поміщаються в цей ліміт.
