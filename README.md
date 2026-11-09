# voice-notes-worker

iPhone Shortcut записує голос і шле файл на цей Cloudflare Worker. Воркер транскрибує запис через Workers AI (`whisper-large-v3-turbo`), генерує назву й summary через OpenAI `gpt-6-luna` (fallback: Workers AI `gemma-4-26b-a4b-it`) і надсилає в Telegram аудіофайл з осмисленою назвою. Якщо шорткат надіслав знімок Things, задачі з нотатки проходять тріаж (дублікати, область, теги, дати), а під аудіо з'являється кнопка «➕ Додати в Things».

```
Shortcut ──POST m4a (+ знімок Things)──▶ fetch (producer) ──▶ R2 + Queue ──▶ queue (consumer)
                                                         │  R2 → Whisper → gpt-6-luna (або Gemma 4): summary → тріаж задач
                                                         │  → Telegram sendAudio (підпис + кнопка «Додати в Things»)
                                                         └─ після 4 невдалих повторів → DLQ → повідомлення про помилку в Telegram
```

## Структура

```
wrangler.toml          bindings: R2, Queue producer/consumer, DLQ, AI; vars TIMEZONE, PUBLIC_URL
src/index.ts           producer, consumer, DLQ consumer, summary, Telegram, тип Env
src/llm.ts             виклик зі structured output: gpt-6-luna, при збої Gemma 4
src/things.ts          знімок Things, тріаж, посилання й сторінка «Додати в Things»
src/things-rules.txt   теги й правила тріажу (редагуєш ти, потім деплой)
.dev.vars.example      шаблон секретів для локального запуску
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
npx wrangler secret put OPENAI_KEY      # для gpt-6-luna; без нього summary робить Gemma 4
npx wrangler secret put BOT_TOKEN       # від @BotFather
npx wrangler secret put CHAT_ID         # ваш chat id (напишіть боту, потім https://api.telegram.org/bot<TOKEN>/getUpdates)

# 4. Деплой
npx wrangler deploy
```

Після деплою wrangler покаже URL на кшталт `https://voice-notes-worker.<subdomain>.workers.dev`.

Логи: `npx wrangler tail` або Workers Logs у дашборді.

## iPhone Shortcut

Дії по порядку:

1. **Record Audio**: Audio Quality: Normal, Start Recording: Immediately, Finish Recording: On Tap.
2. **Find Items** (Things): Type **is** Project, Status **is** Open. Перейменуй результат на `Projects`.
3. **Find Items** (Things): Type **is** Area. Перейменуй на `Areas`.
4. **Find Items** (Things): Type **is** To-Do, Status **is** Open, Limit 500. Перейменуй на `Todos`.
5. **Get Contents of URL**:
   - URL: `https://voice-notes-worker.<subdomain>.workers.dev`
   - Method: **POST**
   - Headers: `x-secret` = значення `SECRET`
   - Request Body: **Form**, поля:
     - `audio`: тип **File** → **Recorded Audio**
     - `projects`: тип **Text** → змінна `Projects`, у ній властивість **Title**
     - `areas`: тип **Text** → `Areas` → **Title**
     - `todos`: тип **Text** → `Todos` → **Title**

     Список назв у текстовому полі Shortcuts сам з'єднує через новий рядок, а воркер так його й читає.
6. (опційно) **Show Notification** з **Contents of URL**: воркер відповідає `ok`, обробка йде у фоні.

Кроки 2–4 і поля `projects`/`areas`/`todos` необов'язкові. Без них (або зі старим варіантом Request Body: **File**) усе працює як раніше, просто без тріажу й кнопки Things.

## Локальний тест

```sh
cp .dev.vars.example .dev.vars   # заповніть ключі, якщо хочете пройти весь ланцюжок
npm run dev   # wrangler dev з PUBLIC_URL=http://localhost:8787, щоб кнопка Things вела на локальний сервер

# тестовий m4a (macOS):
say -o test.m4a --file-format=m4af --data-format=aac "Привіт, це тестовий голосовий запис."

curl -X POST http://localhost:8787 \
  -H "x-secret: local-test" \
  --data-binary @test.m4a
# → ok

# з тестовим знімком Things (тріаж + кнопка):
curl -X POST http://localhost:8787 -H "x-secret: local-test" \
  -F "audio=@test.m4a;type=audio/mp4" \
  -F $'areas=Work\nHome\nShopping' \
  -F $'todos=Купити молоко'
```

`wrangler dev` локально емулює R2 і Queue, тож consumer спрацює одразу в тому ж процесі. Binding `AI` навіть локально звертається до справжнього Workers AI (з безкоштовної квоти), тож для повного ланцюжка потрібні лише `wrangler login` і `BOT_TOKEN`/`CHAT_ID`.

## Як це працює

- **Ідемпотентність.** Поруч з аудіо в R2 лежить `<key>.state.json`: транскрипт, title/summary, `audioSent`. Повторна спроба продовжує з місця, де зупинилась: не платить вдруге за Whisper/LLM і не дублює вже надіслане в Telegram. Після повного успіху обидва об'єкти видаляються, тож повторна доставка того самого повідомлення бачить, що файлу немає, і просто робить ack.
  Залишкове вікно: якщо воркер впаде рівно між успішною відповіддю Telegram і записом стану, одне повідомлення може задублюватись. Telegram не має idempotency key, тож повністю закрити це неможливо.
- **Видалення з R2:** обидва варіанти разом. Після успіху файл видаляється одразу (не лежить зайвий час, не займає місце), а lifecycle rule на 7 днів прибирає те, що не дійшло до успіху: DLQ, завеликі файли. Так файл з DLQ ще тиждень доступний для ручного розбору.
- **Файл > 25 MB**: Whisper працює ~9x швидше за реальний час (25 хв аудіо ≈ 170 с, перевірено), а consumer має 15 хв wall time, тож 25 MB (~50–100 хв аудіо) це поріг із запасом. Більші файли не ретраяться, оригінал іде в Telegram з поясненням. Якщо файл > 50 MB (ліміт upload для Bot API), надсилається лише текстове повідомлення з ключем.
- **Summary**: основна модель `gpt-6-luna` (OpenAI Responses API, `reasoning.effort: "none"`). Якщо вона недоступна (помилка API, немає кредитів, немає `OPENAI_KEY`) або повернула невалідну відповідь, пробуємо `@cf/google/gemma-4-26b-a4b-it` у Workers AI. В обох моделей вимкнений reasoning і structured output (JSON Schema), тож відповідь завжди має форму `{title, summary}`. Fallback лишається на випадок відмови моделі чи порожніх полів.
- **Якщо не впоралась жодна з двох моделей**, повідомлення ретраїться, а на останній спробі використовується fallback (title = дата/час, summary = перші 300 символів), щоб нотатка не загубилась у DLQ лише через summary.
- **Транскрипт у Telegram не надсилається**: він потрібен лише для генерації title і summary. Підпис: назва, summary (2–4 речення), потім буллетами «💡 Ключові думки» (до 5) і «✅ Задачі» (до 10). Порожні списки не показуються, підпис обрізається до 1024 символів.

## Тріаж задач для Things

Працює, лише якщо шорткат надіслав знімок Things і в нотатці є задачі.

- **Знімок**: назви відкритих проєктів, областей і задач (до 500, ліміт `Find Items`). Зберігається в R2 поруч з аудіо й видаляється разом з ним.
- **Тріаж**: один виклик `gpt-6-luna` (`reasoning.effort: "low"`, fallback Gemma 4) зі structured output. Для кожної задачі модель повертає:
  - дослівну цитату із запису (`quote`); пріоритет, «коли» й дедлайн вона виводить лише з цієї цитати, щоб терміновість однієї задачі не перекидалась на сусідні;
  - назву задачі, дублікат (`duplicate_of`), область чи проєкт, теги, `when`, `deadline`.
- **Перевірки у воркері** (модель не може «вигадати»): область і теги лише з реальних (`enum` у схемі + повторна перевірка), дублікат зараховується, лише якщо така назва справді є у знімку, тег з назвою обраної області відкидається, дати лише у форматі Things. **В Inbox задача йде, лише якщо немає ні області (проєкту), ні тегів.** Є область → в неї. Немає області, але є теги → у Anytime з тегами (воркер ставить `when: anytime`, бо інакше Things поклав би її в Inbox; якщо дату названо, лишається вона). У підписі: `→ Work`, `📋 Anytime` або `→ Inbox`.
- **Дублікати** визначаються за змістом серед відкритих задач (лише назви, без нотаток і Logbook). Часткові збіги («купити молоко і хліб» при наявній «Купити молоко») розпізнаються не завжди.
- **Кнопка «➕ Додати в Things (N)»** веде на `PUBLIC_URL/things/<id>`. Сторінка відкриває `things:///json` з новими задачами (Telegram-кнопки підтримують лише http(s), тож напряму `things://` не можна). Посилання одноразове: повторне відкриття показує «Вже додано» з можливістю додати ще раз. Зберігається в R2 до 7 днів (lifecycle). У нотатках кожної задачі: `🎙 <назва нотатки> (дата)`.
- **Правила** — у `src/things-rules.txt`: секція `[теги]` (лише ці теги дозволені) і `[правила]` (довільний текст для моделі). Після змін — `npx wrangler deploy`.
- Невдалий тріаж не блокує нотатку: вона прийде без кнопки.

## Workers AI

Whisper (і резервна Gemma 4) працюють через binding `AI`. Безкоштовна квота: 10 000 neurons на день (і на Free-плані). Whisper коштує ~47 neurons за хвилину аудіо (~200 хв на день безкоштовно), а summary однієї нотатки ~20–50 neurons. Ціни: https://developers.cloudflare.com/workers-ai/platform/pricing/

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

Один запис коштує близько 3–5 операцій Queues, тож Free вистачає з великим запасом. Код майже не використовує CPU (здебільшого чекає на мережу), тому 10 ms на Free має вистачати. Але якщо в логах з'являться `exceededCpu`, допоможе перехід на Paid.

Джерела: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries/).
