# voice-notes-worker

iPhone Shortcut записує голос і шле файл на цей Cloudflare Worker. Воркер транскрибує запис (OpenAI Whisper), генерує назву й summary (OpenAI gpt-6-luna) і надсилає в Telegram аудіофайл з осмисленою назвою.

```
Shortcut ──POST m4a──▶ fetch (producer) ──▶ R2 + Queue ──▶ queue (consumer)
                                                         │  R2 → Whisper → gpt-6-luna → Telegram sendAudio (+ sendMessage з транскриптом)
                                                         └─ після 4 невдалих повторів → DLQ → повідомлення про помилку в Telegram
```

## Структура

```
wrangler.toml       bindings: R2, Queue producer/consumer, DLQ
src/index.ts        увесь код: producer, consumer, DLQ consumer, тип Env
.dev.vars.example   шаблон секретів для локального запуску
```

## Налаштування

```sh
npm install
npx wrangler login

# 1. R2-бакет і lifecycle rule (страховка: прибирає все старше 7 днів)
npx wrangler r2 bucket create voice-notes
npx wrangler r2 bucket lifecycle add voice-notes expire-7d --expire-days 7

# 2. Черга та dead-letter queue
npx wrangler queues create voice-notes
npx wrangler queues create voice-notes-dlq

# 3. Секрети (кожна команда інтерактивно попросить значення)
npx wrangler secret put SECRET          # будь-який довгий випадковий рядок, напр. `openssl rand -hex 32`
npx wrangler secret put OPENAI_KEY      # для Whisper і gpt-6-luna
npx wrangler secret put BOT_TOKEN       # від @BotFather
npx wrangler secret put CHAT_ID         # ваш chat id (напишіть боту, потім https://api.telegram.org/bot<TOKEN>/getUpdates)

# 4. Деплой
npx wrangler deploy
```

Після деплою wrangler покаже URL на кшталт `https://voice-notes-worker.<subdomain>.workers.dev`.

Логи: `npx wrangler tail` або Workers Logs у дашборді.

## iPhone Shortcut

1. **Record Audio**: формат за замовчуванням (m4a). За бажанням "Start Recording: Immediately".
2. **Get Contents of URL**:
   - URL: `https://voice-notes-worker.<subdomain>.workers.dev`
   - Method: **POST**
   - Headers: `x-secret` = значення `SECRET`
   - Request Body: **File** → змінна **Recorded Audio**
3. (опційно) **Show Notification** з результатом. Воркер відповідає `ok` одразу після збереження файлу, а обробка йде у фоні.

## Локальний тест

```sh
cp .dev.vars.example .dev.vars   # заповніть ключі, якщо хочете пройти весь ланцюжок
npx wrangler dev

# тестовий m4a (macOS):
say -o test.m4a --file-format=m4af --data-format=aac "Привіт, це тестовий голосовий запис."

curl -X POST http://localhost:8787 \
  -H "x-secret: local-test" \
  --data-binary @test.m4a
# → ok
```

`wrangler dev` локально емулює R2 і Queue, тож consumer спрацює одразу в тому ж процесі. Без справжніх ключів він впаде на Whisper (401) і піде на retry, і це очікувано.

## Як це працює

- **Ідемпотентність.** Поруч з аудіо в R2 лежить `<key>.state.json`: транскрипт, title/summary, `audioSent`, `textPartsSent`. Повторна спроба продовжує з місця, де зупинилась: не платить вдруге за Whisper/gpt-6-luna і не дублює вже надіслане в Telegram. Після повного успіху обидва об'єкти видаляються, тож повторна доставка того самого повідомлення бачить, що файлу немає, і просто робить ack.
  Залишкове вікно: якщо воркер впаде рівно між успішною відповіддю Telegram і записом стану, одне повідомлення може задублюватись. Telegram не має idempotency key, тож повністю закрити це неможливо.
- **Видалення з R2:** обидва варіанти разом. Після успіху файл видаляється одразу (не лежить зайвий час, не займає місце), а lifecycle rule на 7 днів прибирає те, що не дійшло до успіху: DLQ, завеликі файли. Так файл з DLQ ще тиждень доступний для ручного розбору.
- **Файл > 25 MB** (ліміт Whisper): без ретраїв, оригінал іде в Telegram з поясненням. Якщо файл > 50 MB (ліміт upload для Bot API), надсилається лише текстове повідомлення з ключем.
- **Summary** генерує `gpt-6-luna` через Responses API з `reasoning.effort: "none"` і structured output (JSON Schema), тож відповідь завжди має форму `{title, summary}`. Fallback лишається на випадок відмови моделі чи порожніх полів.
- **Помилка API для summary** ретраїться, але на останній спробі використовується fallback (title = дата/час, summary = перші 300 символів), щоб нотатка не загубилась у DLQ лише через summary.
- **Короткий транскрипт** (коли `title + summary + транскрипт` вміщаються в 1024 символи) іде прямо в caption. Довший надсилається окремими повідомленнями до 4096 символів.

## Ліміти Cloudflare (звірено з документацією 2026-11-09)

| | Free | Paid ($5/міс) |
|---|---|---|
| Queues | доступні | доступні |
| Операції Queues | 10 000/день | 1 млн/міс + $0.40/млн |
| Retention повідомлень | 24 год (фіксовано) | 4 дні за замовчуванням, до 14 |
| Розмір повідомлення | 128 KB | 128 KB |
| Wall time consumer | 15 хв | 15 хв |
| CPU time | 10 ms | 30 с за замовчуванням, до 5 хв |
| Subrequests на виклик | 50 | 10 000 |
| Тіло вхідного запиту | 100 MB (залежить від тарифу домену) | те саме |

Один запис коштує близько 3–5 операцій Queues, тож Free вистачає з великим запасом. Код майже не використовує CPU (здебільшого чекає на мережу), тому 10 ms на Free має вистачати. Але якщо в логах з'являться `exceededCpu` або помилки на кшталт "Too many subrequests" (дуже довгі транскрипти), допоможе перехід на Paid.

Джерела: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries/).
