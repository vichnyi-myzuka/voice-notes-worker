# voice-notes-worker

iPhone Shortcut записує голос і шле файл на цей Cloudflare Worker. Воркер транскрибує запис через Workers AI (`whisper-large-v3-turbo`), генерує назву й summary через OpenAI `gpt-6-luna` (fallback: Workers AI `gemma-4-26b-a4b-it`) і надсилає в Telegram аудіофайл з осмисленою назвою. Якщо задано `TODOIST_TOKEN`, воркер читає проєкти, мітки й відкриті задачі з Todoist, задачі з нотатки проходять тріаж (дублікати, проєкт, мітки, пріоритет, дати), а після публікації воркер одразу створює задачі в Todoist (у підписі назви задач стають посиланнями на них у Todoist); задачі про роботу над проєктом додатково стають GitHub issues (див. «GitHub issues для задач про проєкт»). Нотатку можна також написати текстом (див. «Текстові нотатки» у [docs/notes.md](docs/notes.md)) або надіслати фото (див. «Фото-нотатки» у [docs/notes.md](docs/notes.md)). Нотатку можна відредагувати відповіддю (голосом або текстом) на неї в каналі. Задачі колись були одноразово мігровані з Things окремим скриптом (поза репозиторієм).

```
Shortcut ──POST m4a──▶ fetch (producer) ──▶ R2 + Queue ──▶ queue (consumer)
                                        │  R2 → Whisper → gpt-6-luna (або Gemma 4): summary → Todoist (/sync) → тріаж задач
                                        │  → Telegram sendAudio (підпис, без кнопок) → /sync batch у Todoist → підпис з посиланнями на задачі
                                        └─ після 4 невдалих повторів → DLQ → повідомлення про помилку в Telegram
Telegram ──відповідь (голос/текст) на нотатку──▶ вебхук ──▶ черга ──▶ правка в Todoist + підпис на місці (з посиланнями)
```

## Структура

Моно-репозиторій на npm workspaces: `apps/*` — воркери, `packages/*` — спільний код. Застосунки залежать від пакетів, але не один від одного.

```
packages/core/        спільне ядро, імпортується як `@voice-notes/core` (лише через `src/index.ts`):
                       порти Channel і Llm, JSON-типи, адаптери Telegram і Llm (Workers AI / OpenAI), openSteps, safeEqual
packages/oauth/       `@voice-notes/oauth`: вхід OAuth 2.0 (code + PKCE, статичний чи динамічний клієнт, оновлення токена) з токенами в Durable Object; використовує агент (Сільпо, Google Calendar)
packages/telegram-format/  `@voice-notes/telegram-format`: Markdown → HTML Telegram (chatHtml), таблиці → картки, згорнута цитата; чиста логіка без мережі
apps/agent/            воркер агента (прототип): сесії OpenCode у контейнерах Cloudflare, див. [docs/agent.md](docs/agent.md)
apps/notes/            воркер нотаток (цей бот); команди wrangler запускай із цієї теки
apps/notes/wrangler.toml  bindings: R2, Queue producer/consumer, DLQ, AI; vars TIMEZONE
apps/notes/test/       тести воркера нотаток
apps/notes/test-audio/ тестові голосові записи
apps/notes/src/index.ts  entrypoint: складає адаптери (канал, трекер) і підключає fetch (inbox) та queue (queue)
apps/notes/src/<шар>/<модуль>/    шари: interface → application → domain, infrastructure; модуль — папка з index.ts (публічний інтерфейс), types.ts за потреби і кількома змістовними файлами (без файлів на одну константу чи функцію)
  interface/           точки входу
    inbox/             HTTP: вебхук каналу (через Channel) і завантаження з шорткату
    queue/             споживачі черги й DLQ
  application/         сценарії
    intake/            acceptIncoming (нова нотатка чи правка) і enqueueNote: запис → R2 + черга
    pipeline/          processNote / processEdit — кроки обробки запису, showNote; State зі слайсів модулів
    understand/        readImage (vision), summarize, editNote — промпти й схеми (моделі через порт Llm)
    setup/             команди налаштування («створи проєкт…», описи міток у «⚙️ Правила»), runSetup
    tasks/             задачі нотатки в трекері: syncTasks (ops → actionId → tasksApplied), planOps, applyOps, стан TrackedTasks (порт TaskLedger)
  domain/              правила й дані предметної області
    tracker/           порт трекера задач (TaskTracker) і нейтральні типи (TriageItem, TaskOp, SetupPlan…); Todoist — лише адаптер
    note/              чиста логіка нотатки: Meta, підпис, хештеги, посилання на задачі, текстові нотатки
    published/         опублікована нотатка: Note і порт NoteRepository
    recording/         порт RecordingStore (записи, підписи, стан обробки), ключі запису, ліміти розміру, час запису
  infrastructure/      зовнішні сервіси й сховище
    env/               Env і Job
    r2/                адаптери RecordingStore, NoteRepository і TaskLedger (записи, нотатки та задачі нотаток у R2)
    todoist/           адаптер TaskTracker для Todoist: API (/sync), команди, валідація полів задач, тріаж, налаштування проєктів і міток
AGENTS.md              правила роботи з репозиторієм для агентів
docs/agents/           довідники для агентів: нюанси API (api-notes.md), локальний e2e (local-e2e.md), трекер задач, домен
.dev.vars.example      (в apps/notes) шаблон секретів для локального запуску
```

### Архітектура

Залежності йдуть згори вниз: `interface` → `application` → `domain`; `infrastructure` реалізує порти домену. Ядро (`interface`, `application`, `domain`) не знає ні про Telegram, ні про Todoist, лише про порти:

- **`Channel`** (`packages/core`, `domain/channel`): звідки приходять записи й куди публікуються нотатки. Реалізація: `packages/core` → `infrastructure/telegram` (вебхук, Bot API, сутності тексту, реакції, ліміти підпису).
- **`TaskTracker`** (`domain/tracker`): знімок проєктів і міток, тріаж, створення й оновлення задач, налаштування проєктів і міток. Реалізація: `infrastructure/todoist` (`/sync`, команди, промпти й валідація полів задач).

- **`RecordingStore`**, **`NoteRepository`** і **`TaskLedger`** (`domain/recording`, `domain/published`, `domain/tracker`): збереження сирих записів (разом із підписами й станом обробки), нотаток і задач нотаток. Реалізація: `infrastructure/r2`.
- **`Llm`** (`packages/core`, `domain/llm`): structured output і розпізнавання голосу. Реалізація: `packages/core` → `infrastructure/llm`.

Адаптери створюються в `src/index.ts` і передаються вниз як `{ channel, tracker, notes, ledger, llm }`. Домен не імпортує `infrastructure`. Запис у R2 (аудіо, `<key>.state.json`) лишається в `application` через `Env`. Щоб підключити інший канал чи трекер, потрібно реалізувати відповідний інтерфейс; промпти тріажу при цьому належать адаптеру, бо описують модель конкретного трекера.

Службові дані каналу (`fileId`, `deleteChatId`…) лежать у `customMetadata` запису в R2, ядро передає їх каналу як є. Ключ списку задач нотатки в R2 — `notes/<id>.tasks.json` (старі нотатки з ключем `.todoist.json` читаються за запасним шляхом, поки не застаріють).

## Налаштування

```sh
npm install
cd apps/notes   # усі команди wrangler нижче запускаються звідси
npx wrangler login

# 1. R2-бакет і lifecycle rule (страховка: прибирає все старше 7 днів)
npx wrangler r2 bucket create voice-notes
npx wrangler r2 bucket lifecycle add voice-notes expire-7d --expire-days 7

# 2. Черга та dead-letter queue
npx wrangler queues create voice-notes
npx wrangler queues create voice-notes-dlq

# 3. Секрети (кожна команда інтерактивно попросить значення)
npx wrangler secret put SECRET          # будь-який довгий випадковий рядок, напр. `openssl rand -hex 32`
npx wrangler secret put OPENAI_API_KEY      # для gpt-6-luna; без нього summary робить Gemma 4
npx wrangler secret put BOT_TOKEN       # від @BotFather
npx wrangler secret put CHAT_ID         # ваш chat id (напишіть боту, потім https://api.telegram.org/bot<TOKEN>/getUpdates)
# необов'язково, для голосових прямо з Telegram (див. docs/notes.md, «Голосові з Telegram»):
npx wrangler secret put TG_WEBHOOK_SECRET  # `openssl rand -hex 32`
npx wrangler secret put TG_OWNER_ID        # ваш Telegram user id (для особистого чату з ботом)
# необов'язково, але без нього нотатки йдуть без тріажу й задач у Todoist:
npx wrangler secret put TODOIST_TOKEN   # Todoist → Settings → Integrations → Developer → API token
# необов'язково: GitHub issues для задач про проєкт (див. docs/notes.md, «GitHub issues для задач про проєкт»):
npx wrangler secret put GITHUB_ISSUES_TOKEN   # fine-grained PAT, Issues: write лише на репозиторії з ISSUE_REPOS

# 4. Деплой
npx wrangler deploy
```

Після деплою wrangler покаже URL на кшталт `https://notes.example.com`.

Логи: `npx wrangler tail` або Workers Logs у дашборді.

## iPhone Shortcut

Дії по порядку:

1. **Record Audio**: Audio Quality: Normal, Start Recording: Immediately, Finish Recording: On Tap.
2. **Get Contents of URL**:
   - URL: `https://notes.example.com`
   - Method: **POST**
   - Headers: `x-secret` = значення `SECRET`
   - Request Body: **Form**, поле `audio`: тип **File** → **Recorded Audio**
3. (опційно) **Show Notification** з **Contents of URL**: воркер відповідає `ok`, обробка йде у фоні.

Проєкти, мітки й задачі шорткат не надсилає: воркер бере їх із Todoist сам. Будь-які інші поля форми ігноруються.

## Тести, lint і git-хуки

- `npm run lint` — oxlint (`src`, `test` кожного застосунку й пакета) з конфігом `.oxlintrc.json` у корені: у `src` заборонено імпорт у внутрішні файли чужого модуля (лише через `index.ts`) і `@voice-notes/core/*`; тести винятку не мають.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — vitest: наскрізний e2e через `worker.fetch` і `worker.queue` з підміненими OpenAI, Telegram і Todoist (`apps/notes/test/e2e.test.ts`: вебхук → нотатка → задача → «Видали нотатку»), unit-тести кроків обробки (`apps/notes/test/steps.test.ts`), маршрутизація `handleFetch` із каналом-заглушкою (`apps/notes/test/inbox.test.ts`), наскрізні `processNote` і `processEdit` з підміненими OpenAI і Telegram (`apps/notes/test/process-note.test.ts`: публікація, правка й повтор після збою без повторного LLM), чистої логіки (підпис і хештеги, розбір відповідей моделі й ключі задач при редагуванні, валідація полів задач Todoist, `planOps` (create/update/delete), `buildCommands`, `applyOps` і `syncTasks` з підміненим `fetch`, перехід на літній час, фільтр вхідних повідомлень Telegram). Тести Todoist — у `apps/notes/test/todoist.test.ts` і `apps/notes/test/sync-tasks.test.ts`. Без мережі й без LLM — у `apps/notes/test/fake-env.ts` R2 у пам'яті.
- `npm run check` — усе разом (lint + typecheck + test).

Git-хуки лежать в `.githooks/` і вмикаються автоматично після `npm install` (скрипт `prepare` ставить `core.hooksPath`):
- pre-commit = lint + typecheck;
- pre-push = `npm run check`.

Якість промптів (регресії LLM) перевіряється вручну на записах з `apps/notes/test-audio/` (див. розділ нижче), а не в хуках: це платні моделі й десятки секунд.

У надзвичайній ситуації обійти хуки: `git commit --no-verify`.

## Локальний тест

```sh
cd apps/notes && cp .dev.vars.example .dev.vars   # заповніть ключі, якщо хочете пройти весь ланцюжок
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

Тестові записи (синтез голосом Lesya через `say`) лежать у `apps/notes/test-audio/` і комітяться:

| Файл | Що перевіряє |
|---|---|
| `shopping-list.m4a` | список з 10 продуктів → окремі задачі в Shopping; якщо «Купити молоко» вже відкрита в Todoist — дублікат |
| `silence.m4a` | тиша → нічого не публікується (`discarded: empty`) |
| `cancelled.m4a` | «…стоп, скасуй цей запис» → нічого не публікується (`discarded: cancelled`) |
| `cancel-meeting-task.m4a` | «скасувати зустріч», «відмінити підписку» — це задачі, нотатка публікується |
| `edit-today.m4a`, `edit-remove.m4a` | інструкції редагування для ручної перевірки: «обидві на сьогодні + перейменуй» → 2 update; «прибери зустріч» → 1 delete |
| `edit-instruction.m4a` | інструкція редагування: «прибери задачу про Netflix, додай купити квіти мамі, терміново» |
| `times.m4a` | «до 13:00 надіслати фото», «о 19:00 пост», «до п'ятниці звіт» → дата виконання з часом, без дубля в дедлайні |
| `reminders.m4a` | «зустріч завтра о 16, нагадай за годину», «оплатити інтернет, нагадай завтра о 9» → relative −60 хв і absolute 09:00 |
| `setup-commands.m4a` | «створи проєкт Спорт…», «додай мітку Online…», «купити кросівки» → новий проєкт з описом, мітка з рядком у правилах, одна задача (Whisper чує «Створив … Project Sport» — так теж має спрацювати) |
| `mixed-tasks.m4a` | задачі в різних проєктах, пріоритет (p1), мітка `Pending`, дедлайн, «колись» → Want |

```sh
source .env && curl -X POST https://notes.example.com -H "x-secret: $SECRET" \
  -F "audio=@apps/notes/test-audio/shopping-list.m4a;type=audio/mp4"
```

`wrangler dev` локально емулює R2 і Queue, тож consumer спрацює одразу в тому ж процесі. Binding `AI` навіть локально звертається до справжнього Workers AI (з безкоштовної квоти), тож для повного ланцюжка потрібні лише `wrangler login` і `BOT_TOKEN`/`CHAT_ID`.

## CI/CD

Зміни потрапляють у `main` лише через PR, розгортання робить GitHub Actions (`.github/workflows`):

- `check.yml`: на кожен PR і перед кожним деплоєм `npm run check` (oxlint, tsc, vitest). Секретів у цьому job немає: код з PR (зокрема від агента) виконується тут, тож Cloudflare-токен йому недоступний.
- `deploy.yml`: після мержу в `main` спершу `check`, потім розгортаються лише змінені застосунки (`notes`, `sites`, `agent`; зміни в `packages/`, `package-lock.json` зачіпають усі). Вручну: Actions → deploy → Run workflow (`apps`: `all`, `notes`, `agent`, `sites`).
- `notes` і `sites` розгортаються самі (environment `production`), `agent` чекає твого схвалення (environment `production-agent`): деплой замінює контейнер, а зміна образу скидає знімки. `CLOUDFLARE_API_TOKEN` і `CLOUDFLARE_ACCOUNT_ID` лежать лише в секретах environments, не репозиторію.
- `CODEOWNERS` позначає власником `.github/`, `wrangler.toml`, `apps/agent/container/` і `apps/agent/payload/`.

Агент не має доступу до Cloudflare: його токен GitHub пушить у гілки й відкриває PR, але не має права `workflows` (змінити workflow й дістати секрет не вийде).

Домени воркерів у репозиторії не зберігаються: CI підставляє `--domain <застосунок>.$BASE_DOMAIN` (`notes.`, `agent.`, `sites.`, а для публічних сайтів `share.`). Базовий домен задає секрет `BASE_DOMAIN` в обох environments (саме секрет, а не змінна: GitHub маскує його в публічних логах як `***`). У прикладах цього README `example.com` замінюй на свій домен. Локальний аварійний деплой: `npm run deploy -w apps/<назва> -- --domain <назва>.<домен>`.

### Налаштування GitHub (робить власник)

1. **Репозиторій публічний** (Settings → General → Danger Zone): тільки так на безкоштовному плані доступні rulesets і environment-схвалення.
2. **Environments** (Settings → Environments): `production` (без обмежень) і `production-agent` (Required reviewers: ти). У кожному секрети `CLOUDFLARE_API_TOKEN` , `CLOUDFLARE_ACCOUNT_ID` і `BASE_DOMAIN` (твій базовий домен).
3. **Токен Cloudflare** (My Profile → API Tokens → Custom token) лише для одного акаунта: Account → Workers Scripts: Edit; Account → Cloudchamber (Containers): Edit; Zone → Workers Routes: Edit для `example.com`. Без DNS, Access і Billing. Якщо `wrangler deploy` скаже про нестачу права, додавай по одному.
4. **Ruleset на `main`** (Settings → Rules → Rulesets): Require a pull request (0 схвалень: схвалити власний PR неможливо), Require status checks → `check`, Block force pushes, без bypass-списку (токен агента діє від твого імені, тож bypass для admin зняв би захист).
5. **Токен агента**: fine-grained PAT на потрібні репозиторії: Contents, Pull requests: Read and write; без Workflows, Actions і Administration (`wrangler secret put GITHUB_TOKEN` в `apps/agent`).

Після цього пуш у `main` напряму заборонено всім, зокрема власнику: працюємо через PR.

## Документація

Усе, що не потрібне для першого запуску, винесено в `docs/`:

- [`docs/notes.md`](docs/notes.md): поведінка бота нотаток (голос, текст, фото, редагування, дати й повтори задач, хештеги, тріаж Todoist, GitHub issues, проєкти й мітки голосом).
- [`docs/agent.md`](docs/agent.md): агент (`apps/agent`): контейнер, API, запобіжники, налаштування, знімки диска, підписка Claude.
- [`docs/agent-chat.md`](docs/agent-chat.md): чат з агентом у Telegram і автоматизація GitHub → Telegram.
- [`docs/agent-integrations.md`](docs/agent-integrations.md): сайти агента (`apps/sites`, публічні сайти), MCP Sure, Сільпо, Google Calendar.
- [`docs/cloudflare.md`](docs/cloudflare.md): Workers AI, ліміти й витрати Cloudflare.
- [`docs/adr/`](docs/adr), [`GLOSSARY.md`](GLOSSARY.md): рішення й словник; [`docs/agents/`](docs/agents): довідники для агентів.
