# voice-notes-worker

iPhone Shortcut записує голос і шле файл на цей Cloudflare Worker. Воркер транскрибує запис через Workers AI (`whisper-large-v3-turbo`), генерує назву й summary через OpenAI `gpt-6-luna` (fallback: Workers AI `gemma-4-26b-a4b-it`) і надсилає в Telegram аудіофайл з осмисленою назвою. Якщо задано `TODOIST_TOKEN`, воркер читає проєкти, мітки й відкриті задачі з Todoist, задачі з нотатки проходять тріаж (дублікати, проєкт, мітки, пріоритет, дати), а після публікації воркер одразу створює задачі в Todoist (у підписі назви задач стають посиланнями на них у Todoist). Нотатку можна відредагувати відповіддю (голосом або текстом) на неї в каналі. Задачі колись були одноразово мігровані з Things окремим скриптом (поза репозиторієм).

```
Shortcut ──POST m4a──▶ fetch (producer) ──▶ R2 + Queue ──▶ queue (consumer)
                                        │  R2 → Whisper → gpt-6-luna (або Gemma 4): summary → Todoist (/sync) → тріаж задач
                                        │  → Telegram sendAudio (підпис, без кнопок) → /sync batch у Todoist → підпис з посиланнями на задачі
                                        └─ після 4 невдалих повторів → DLQ → повідомлення про помилку в Telegram
Telegram ──відповідь (голос/текст) на нотатку──▶ вебхук ──▶ черга ──▶ правка в Todoist + підпис на місці (з посиланнями)
(callback «td:<id>» лишився лише для кнопок у нотатках, опублікованих до автододавання)
```

## Структура

```
wrangler.toml          bindings: R2, Queue producer/consumer, DLQ, AI; vars TIMEZONE
src/index.ts           producer, consumer, DLQ consumer, summary, редагування, автододавання в Todoist, callback старих кнопок, тип Env
src/llm.ts             виклик зі structured output: gpt-6-luna, при збої Gemma 4
src/todoist.ts         Todoist API (/sync), тріаж, операції create/update/delete, виконання збережених дій
src/todoist-rules.txt  описи міток і правила тріажу (редагуєш ти, потім деплой)
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
# необов'язково, для голосових прямо з Telegram (див. «Голосові з Telegram»):
npx wrangler secret put TG_WEBHOOK_SECRET  # `openssl rand -hex 32`
npx wrangler secret put TG_OWNER_ID        # ваш Telegram user id (для особистого чату з ботом)
# необов'язково, але без нього нотатки йдуть без тріажу й задач у Todoist:
npx wrangler secret put TODOIST_TOKEN   # Todoist → Settings → Integrations → Developer → API token

# 4. Деплой
npx wrangler deploy
```

Після деплою wrangler покаже URL на кшталт `https://voice-notes-worker.<subdomain>.workers.dev`.

Логи: `npx wrangler tail` або Workers Logs у дашборді.

## iPhone Shortcut

Дії по порядку:

1. **Record Audio**: Audio Quality: Normal, Start Recording: Immediately, Finish Recording: On Tap.
2. **Get Contents of URL**:
   - URL: `https://voice-notes-worker.<subdomain>.workers.dev`
   - Method: **POST**
   - Headers: `x-secret` = значення `SECRET`
   - Request Body: **Form**, поле `audio`: тип **File** → **Recorded Audio**
3. (опційно) **Show Notification** з **Contents of URL**: воркер відповідає `ok`, обробка йде у фоні.

Проєкти, мітки й задачі шорткат не надсилає: воркер бере їх із Todoist сам. Будь-які інші поля форми ігноруються.

## Тести, lint і git-хуки

- `npm run lint` — oxlint (`src`, `test`).
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — vitest: unit-тести чистої логіки (підпис і хештеги, розбір відповідей моделі й ключі задач при редагуванні, валідація полів задач Todoist, `planOps` (create/update/delete), `buildCommands`, `applyAction` з підміненим `fetch`, перехід на літній час, фільтр вхідних повідомлень Telegram). Тести Todoist — у `test/todoist.test.ts`. Без мережі й без LLM — у `test/fake-env.ts` R2 у пам'яті.
- `npm run check` — усе разом (lint + typecheck + test).

Git-хуки лежать в `.githooks/` і вмикаються автоматично після `npm install` (скрипт `prepare` ставить `core.hooksPath`):
- pre-commit = lint + typecheck;
- pre-push = `npm run check`.

Якість промптів (регресії LLM) перевіряється вручну на записах з `test-audio/` (див. розділ нижче), а не в хуках: це платні моделі й десятки секунд.

У надзвичайній ситуації обійти хуки: `git commit --no-verify`.

## Локальний тест

```sh
cp .dev.vars.example .dev.vars   # заповніть ключі, якщо хочете пройти весь ланцюжок
npm run dev   # для тріажу потрібен TODOIST_TOKEN у .dev.vars

# тестовий m4a (macOS):
say -o test.m4a --file-format=m4af --data-format=aac "Привіт, це тестовий голосовий запис."

curl -X POST http://localhost:8787 \
  -H "x-secret: local-test" \
  --data-binary @test.m4a
# → ok

# як з шорткату (форма; тріаж і задачі в Todoist з'являться, якщо задано TODOIST_TOKEN):
curl -X POST http://localhost:8787 -H "x-secret: local-test" \
  -F "audio=@test.m4a;type=audio/mp4"
```

Тестові записи (синтез голосом Lesya через `say`) лежать у `test-audio/` і комітяться:

| Файл | Що перевіряє |
|---|---|
| `shopping-list.m4a` | список з 10 продуктів → окремі задачі в Shopping; якщо «Купити молоко» вже відкрита в Todoist — дублікат |
| `silence.m4a` | тиша → нічого не публікується (`discarded: empty`) |
| `cancelled.m4a` | «…стоп, скасуй цей запис» → нічого не публікується (`discarded: cancelled`) |
| `cancel-meeting-task.m4a` | «скасувати зустріч», «відмінити підписку» — це задачі, нотатка публікується |
| `edit-today.m4a`, `edit-remove.m4a` | інструкції редагування для ручної перевірки: «обидві на сьогодні + перейменуй» → 2 update; «прибери зустріч» → 1 delete |
| `edit-instruction.m4a` | інструкція редагування: «прибери задачу про Netflix, додай купити квіти мамі, терміново» |
| `mixed-tasks.m4a` | задачі в різних проєктах, пріоритет (p1), мітка `Pending`, дедлайн, «колись» → Want |

```sh
source .env && curl -X POST https://voice-notes-worker.<subdomain>.workers.dev -H "x-secret: $SECRET" \
  -F "audio=@test-audio/shopping-list.m4a;type=audio/mp4"
```

`wrangler dev` локально емулює R2 і Queue, тож consumer спрацює одразу в тому ж процесі. Binding `AI` навіть локально звертається до справжнього Workers AI (з безкоштовної квоти), тож для повного ланцюжка потрібні лише `wrangler login` і `BOT_TOKEN`/`CHAT_ID`.

## Голосові з Telegram

Окрім шорткату, запис можна надіслати прямо в Telegram:

- **У канал `CHAT_ID`** — голосове або аудіо **без підпису**. Бот ставить ✍, а після публікації нотатки видаляє оригінал (потрібне право адміна «видаляти повідомлення»). Дописи з підписом ігноруються: так бот не чіпає власних нотаток. Текст у каналі, який не є відповіддю на нотатку, ігнорується.
- **В особистий чат з ботом** — лише від `TG_OWNER_ID`; бот ставить ✍, нотатка з'являється в каналі.

Тріаж працює так само, як і для шорткату: проєкти, мітки й задачі воркер бере з Todoist. Аудіо пересилається в канал за `file_id`. Ліміт Bot API на завантаження — 20 МБ. Whisper приймає Telegram OGG/Opus напряму.

Увімкнути вебхук (після цього `getUpdates` перестає працювати):

```sh
source .env && curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d url=https://voice-notes-worker.<subdomain>.workers.dev/telegram \
  -d secret_token=$TG_WEBHOOK_SECRET \
  --data-urlencode 'allowed_updates=["message","channel_post","callback_query"]' -d drop_pending_updates=true
```

`callback_query` у `allowed_updates` потрібен лише для кнопок у старих нотатках.

## Порожні й скасовані записи

Якщо в записі лише тиша, шум або типові «галюцинації» Whisper на тиші, або якщо автор голосом скасовує запис («скасуй», «відміна, не зберігай»), модель повертає `discard`. Тоді воркер нічого не публікує, не робить тріаж і видаляє файл (а для голосового з каналу — і оригінал). У логах: `<key> discarded: empty|cancelled`. Фрази про реальні речі («скасувати зустріч») — це задачі, а не скасування.

## Редагування нотатки

Нотатку редагують **відповіддю на неї в каналі** (на iPhone: свайп повідомлення вліво) — **голосовим** або **текстом**. Кнопки «Редагувати» немає: Telegram Bot API не вміє відкрити поле відповіді з кнопки. Інструкція («прибери другу задачу», «перенеси зустріч на п'ятницю», «перейменуй на…») розшифровується (текстова відповідь іде без Whisper одразу в модель редагування), LLM повертає оновлену нотатку, тріаж задач робиться заново, зміни одразу застосовуються в Todoist, і повідомлення оновлюється на місці (`editMessageCaption`, аудіо не змінюється). Бот ставить ✍ на відповідь, поки триває редагування — 👨‍💻 на нотатці, а після цього видаляє відповідь.

- Нотатки для редагування зберігаються в R2 (`notes/<id>.json`, `notes/msg-<message_id>`) і живуть 7 днів, як усе в бакеті.
- Модель редагування бачить задачі разом з полями Todoist (проєкт, мітки, пріоритет, `due`, дедлайн) і стабільним ключем (`t1`, `t2`…) і міняє лише те, що просить інструкція («зроби все на сьогодні» → `due` = дата правки для всіх). Назви змінюються лише на явне прохання перейменувати; перенесення в часі міняє тільки `due`/дедлайн. Summary та ключові думки узгоджуються з правкою (напр. змінена дата). «Сьогодні»/«завтра» в правці рахуються від дати правки, а в оригінальному записі — від дати запису.
- **Оновлення в Todoist.** Без кнопки: зміни застосовуються одразу. Змінені задачі оновлюються за ID (`item_update`, плюс `item_move`, якщо змінився проєкт), нові створюються (`item_add`), прибрані видаляються (`item_delete`). Стан нотатки (ключ задачі → ID у Todoist) лежить у R2: `notes/<id>.todoist.json`. Невиконана стара дія (з часів кнопки) після нового редагування замінюється.
- Після виконання назви задач, що вже в Todoist, стають посиланнями `https://app.todoist.com/app/task/<id>` (через `caption_entities`); маркери лишаються «•».
- **Видалення нотатки.** Відповідь «видали нотатку» (голосом або текстом) видаляє всю нотатку: ще відкриті задачі в Todoist (`item_delete`), повідомлення з нотаткою в каналі, саму відповідь і записи нотатки в R2. Виконані задачі лишаються в історії Todoist. Прибрати одну задачу («видали задачу про Netflix») — звичайна правка, нотатка лишається.
- ⚠️ Telegram не повідомляє ботів про видалені повідомлення, тож якщо видалити нотатку в Telegram вручну, задачі в Todoist **не** видаляться — використовуй команду «видали нотатку».
- «Скасуй» в інструкції скасовує саме правку; нотатка лишається як була.

## Хештеги

Останній рядок підпису: `#листопад_2026 #тиждень_46 #Work #Shopping` — місяць, ISO-тиждень (у `TIMEZONE`) і проєкти нових задач з тріажу. Тап на хештег у Telegram показує всі такі записи.

## Як це працює

- **Ідемпотентність.** Поруч з аудіо в R2 лежить `<key>.state.json`: транскрипт, title/summary, `audioSent`. Повторна спроба продовжує з місця, де зупинилась: не платить вдруге за Whisper/LLM і не дублює вже надіслане в Telegram. Після повного успіху обидва об'єкти видаляються, тож повторна доставка того самого повідомлення бачить, що файлу немає, і просто робить ack.
  Залишкове вікно: якщо воркер впаде рівно між успішною відповіддю Telegram і записом стану, одне повідомлення може задублюватись. Telegram не має idempotency key, тож повністю закрити це неможливо.
- **Видалення з R2:** обидва варіанти разом. Після успіху файл видаляється одразу (не лежить зайвий час, не займає місце), а lifecycle rule на 7 днів прибирає те, що не дійшло до успіху: DLQ, завеликі файли. Так файл з DLQ ще тиждень доступний для ручного розбору.
- **Файл > 25 MB**: Whisper працює ~9x швидше за реальний час (25 хв аудіо ≈ 170 с, перевірено), а consumer має 15 хв wall time, тож 25 MB (~50–100 хв аудіо) це поріг із запасом. Більші файли не ретраяться, оригінал іде в Telegram з поясненням. Якщо файл > 50 MB (ліміт upload для Bot API), надсилається лише текстове повідомлення з ключем.
- **Summary**: основна модель `gpt-6-luna` (OpenAI Responses API, `reasoning.effort: "none"`). Якщо вона недоступна (помилка API, немає кредитів, немає `OPENAI_KEY`) або повернула невалідну відповідь, пробуємо `@cf/google/gemma-4-26b-a4b-it` у Workers AI. В обох моделей вимкнений reasoning і structured output (JSON Schema), тож відповідь завжди має форму `{title, summary}`. Fallback лишається на випадок відмови моделі чи порожніх полів.
- **Якщо не впоралась жодна з двох моделей**, повідомлення ретраїться, а на останній спробі використовується fallback (title = дата/час, summary = перші 300 символів), щоб нотатка не загубилась у DLQ лише через summary.
- **Транскрипт у Telegram не надсилається**: він потрібен лише для генерації title і summary. Підпис: назва, summary (2–4 речення), потім буллетами «💡 Ключові думки» (до 5) і «✅ Задачі» (до 10). Порожні списки не показуються, підпис обрізається до 1024 символів.

## Тріаж задач для Todoist

Працює, лише якщо задано `TODOIST_TOKEN` і в нотатці є задачі.

- **Знімок**: перед тріажем (і при редагуванні) воркер читає з Todoist проєкти, мітки й відкриті задачі (`/api/v1/sync`). Нічого не зберігається, шорткат нічого не надсилає.
- **Тріаж**: один виклик `gpt-6-luna` (`reasoning.effort: "low"`, fallback Gemma 4) зі structured output. Для кожної задачі модель повертає:
  - дослівну цитату із запису (`quote`); пріоритет і дати вона виводить лише з цієї цитати, щоб терміновість однієї задачі не перекидалась на сусідні;
  - назву задачі, дублікат (`duplicate_of`), проєкт (`""` = Inbox), мітки, пріоритет p1–p4 (p4 = без пріоритету), `due` і `deadline`.
- **Перевірки у воркері** (модель не може «вигадати»): проєкт і мітки лише з реальних (`enum` у схемі + повторна перевірка), дублікат зараховується, лише якщо така назва справді є серед відкритих задач, мітка з назвою обраного проєкту відкидається. `due` «today»/«tomorrow» перетворюється на дату від дати запису (для правок — від дати правки), інші дати лише у форматі `YYYY-MM-DD`. У підписі: `→ Work p1 @Pending 📅 2026-11-10 ⏰ 2026-11-15` або `→ Inbox`.
- **Дублікати** визначаються за змістом серед відкритих задач (лише назви). Часткові збіги («купити молоко і хліб» при наявній «Купити молоко») розпізнаються не завжди.
- **Автододавання в Todoist.** Нотатка публікується без кнопок, одразу після цього воркер виконує дію одним batch-запитом `/sync` і редагує підпис: назви задач, що вже в Todoist, стають посиланнями на них (`https://app.todoist.com/app/task/<id>`, через `caption_entities`), маркери лишаються «•». Команди мають сталі uuid, тож повтори черги не дублюють задачі. Якщо на останній спробі Todoist усе ще недоступний, нотатка (або правка) все одно публікується з рядком «⚠️ Не вдалося оновити Todoist» у підписі. Дія (pending) лежить в R2 (`todoist/<id>.json`) до 7 днів (lifecycle). В описі кожної задачі: `🎙 <назва нотатки> (дата)` і, якщо `CHAT_ID` — канал або супергрупа (`-100…`), посилання на повідомлення в Telegram (`https://t.me/c/…/<id>`). В особистому чаті з ботом посилань на повідомлення Telegram не має.
- **Правила** — у `src/todoist-rules.txt`: секція `[мітки]` (описи міток: коли яку ставити) і `[правила]` (довільний текст для моделі: проєкти, пріоритети). Самі проєкти й мітки (зараз проєкти Work, Personal affairs, Home, Shopping, Gifts, Want; мітки Important, Pending, Errand, Home, Office) беруться з Todoist. Після змін файлу — `npx wrangler deploy`.
- **Старі кнопки.** Обробник `callback_query` (`td:<id>`, лише для `TG_OWNER_ID`) лишено тільки для кнопок «Додати/Оновити в Todoist» у нотатках, опублікованих до автододавання.
- Невдалий тріаж не блокує нотатку: вона прийде без задач у Todoist.

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
