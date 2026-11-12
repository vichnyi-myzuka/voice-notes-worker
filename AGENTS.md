# AGENTS.md

Правила роботи з репозиторієм для агентів. Репозиторій — моно-репо на npm workspaces: `apps/*` (воркери: `apps/notes` — нотатки, `apps/agent` — спільний контейнер з OpenCode і сесії агента в ньому, `apps/sites` — віддача статичних сайтів агента з R2), `packages/*` (спільний код). Застосунки залежать від пакетів, але не один від одного; пакет імпортується лише через свій `index.ts`. Як працює бот, описано в `README.md`; тут лише те, чого з README не видно.

## Робочий цикл

- Перед комітом: `npm run check` (oxlint + tsc + vitest). Git-хуки однаково запускають pre-commit (lint + typecheck) і pre-push (`npm run check`).
- **Зміни йдуть через PR, деплоїть GitHub Actions** (`.github/workflows`): PR → `check` → мерж у `main` → `deploy` змінених застосунків (`agent` чекає схвалення власника в environment `production-agent`). Агент пушить лише у свою гілку `agent/<назва>` і відкриває PR; у `main` не пушить, `wrangler deploy` не запускає, `.github/` не чіпає. Локальний `npm run deploy -w apps/<назва>` лишається лише власнику для аварійних випадків (`npx wrangler login`). Кроки налаштування GitHub: розділ «CI/CD» у README.
- Зміна поведінки → онови README в тому ж коміті. Нова логіка → unit-тести в `test/` відповідного застосунку (без мережі й LLM; `fetch` підміняється через `vi.stubGlobal`, R2 — `test/fake-env.ts`). Зміна наскрізної поведінки → перевір `apps/notes/test/e2e.test.ts` (повний цикл на моках, без реальних сервісів).

## Секрети

- Значень секретів ніколи не друкуй і не вигадуй. `source .env` у shell можна, `echo $TOKEN` — ні.
- Секрети воркера: `wrangler secret put` (з теки застосунку). Локально `npm run dev` бере їх з `.env` у корені (`--env-file ../../.env`).

## Стиль

- Просто, мінімум абстракцій; невеликі функції поруч з місцем використання. Альтернативні підходи — коротко згадай користувачу, а не впроваджуй мовчки.
- Коментарі в коді, тексти для користувача, промпти щодо результату — українською (самі системні промпти — англійською).
- Нотатки в Telegram: назва, summary, «💡 Ключові думки», «✅ Задачі», маркери «•», порожні секції не показуються, транскрипт не публікується.
- Обробка в черзі ідемпотентна: проміжний стан у R2 (`<key>.state.json`), команди Todoist зі сталими uuid. Нові кроки конвеєра додавай так само (`step("поле", fn, { onFinalFailure })` з `openSteps`; на `lastAttempt` — деградувати, а не падати).

## Код

Порти `Channel` і `Llm`, їхні адаптери (`telegram`, `llm`), `openSteps`, `safeEqual` і JSON-типи живуть у `packages/core` (імпорт `@voice-notes/core`); решта шляхів нижче — всередині `apps/notes/`. У тестах мок внутрішнього модуля core (напр. `safeEqual`) робиться за шляхом файлу в `packages/core/src`. Модуль — папка; зовні імпортуй лише з `index.ts` модуля (`../../application/tasks`; в межах шару — `../tasks`), усередині — з файлів (`./apply`). Стан обробки складається зі слайсів модулів (`SyncState`, `SetupState`, `ContentState`, `PublishState`) у `pipeline/types.ts`. Ядро (domain, application, interface) нічого не знає про Telegram і Todoist: воно працює з портами `Channel`, `TaskTracker`, `NoteRepository`, `TaskLedger`, `Llm` (у `domain`), адаптери — `infrastructure/{todoist,r2}` тут і `telegram`, `llm` у `packages/core`, складання — у `src/index.ts`. Службові дані каналу (`fileId`, `deleteChatId` тощо) лежать у `customMetadata` запису в R2, ядро передає їх каналу як є.

```
apps/agent/src/        domain/agent (порт Agent = Sessions & Computer & Deploys), infrastructure/{container (AgentSession — один Durable Object `main` з єдиним контейнером і всіма сесіями: лише сесії, завдання, стеження й підсумки; решта в модулях поруч: `computer` — контейнер і знімки, `posts` — пост у чаті й деплой, `forms` — питання агента, `proxy` — веб-інтерфейс, `state` — типи й ключі сховища, `config` — ліміти й env; durableAgent — адаптер порту)}, interface/{http, telegram (вебхук чату з агентом повз Access: `handle` — маршрутизація, `commands` — /status, /update…, `buttons` — кнопки), github (вебхук GitHub)}; infrastructure/chat — пости й кнопки в чаті, формат callback_data (`callback.ts`) і спільні дії над повідомленнями (`messages.ts`); interface-модулі залежать від нього, але не один від одного; container/ — образ (лише системне: Node, git, OpenCode, claude, entrypoint); payload/ — те, що воркер розкладає в контейнер сам (AGENTS.md агента, publish, session-prep, git-хук; підключаються як текст); тести з фейком `test/fake-agent.ts`
packages/core/src/      спільне: domain/{channel,llm,json}, infrastructure/{telegram,llm,steps,security,access}; публічний вхід — index.ts
apps/sites/src/        serve (шлях → ключ R2, віддача), index (перевірка Access); тести з R2 у пам'яті
apps/notes/src/index.ts  entrypoint: складає адаптери (канал, трекер) і підключає fetch (inbox) та queue (queue)
src/<шар>/<модуль>/    шари: interface → application → domain, infrastructure; модуль — папка з index.ts (публічний інтерфейс), types.ts за потреби і кількома змістовними файлами (без файлів на одну константу чи функцію)
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
    recording/         ключі запису в R2, ліміти розміру, час запису
  infrastructure/      зовнішні сервіси й сховище
    env/               Env і Job
    r2/                адаптери NoteRepository і TaskLedger (нотатки та задачі нотаток у R2)
    todoist/           адаптер TaskTracker для Todoist: API (/sync), команди, валідація полів задач, тріаж, налаштування проєктів і міток
```

## Локальний e2e (справжній канал і Todoist!)

```sh
cd apps/notes && npx wrangler dev --port 8787 --var LOCAL_DEV:1 --var TG_OWNER_ID:<твій Telegram id> --var TG_WEBHOOK_SECRET:local-webhook-test --env-file ../../.env
```

- Пост у каналі імітується POST на `localhost:8787/telegram` з заголовком `x-telegram-bot-api-secret-token: local-webhook-test` і тілом `{"channel_post":{"message_id":…,"date":…,"chat":{"id":CHAT_ID,"type":"channel"},"text":"…"}}` (правка — з `"reply_to_message":{"message_id":<id нотатки>}`).
- Помилки «message to react/delete not found» для вигаданих `message_id` — очікувані.
- Кінець обробки — рядок `QUEUE voice-notes` у лозі; id опублікованої нотатки — `published as message N`.
- **Тест створює справжні задачі й повідомлення: завжди прибирай** відповіддю «Видали нотатку» на тестову нотатку.
- Не використовуй назви реальних задач користувача (напр. ліки в Health): тріаж позначить їх дублікатами.
- Перевіряти Todoist можна через `td` CLI або `curl` з `$TODOIST_TOKEN`.

## Todoist API — нюанси

- API v1: `/api/v1/sync` для змін, REST лише для читання й uploads. Priority 4 у API = p1 у додатку.
- Архівні проєкти не приходять у `/sync`: «⚙️ Правила» шукаємо ще й через `/projects/archived`.
- Повтор кілька разів на день (`every day at 9:00, 14:00`) → `INVALID_DATE`; `until`, `for N days`, `every 8 hours` працюють. Повтор шлемо як `{string, lang: "en"}`.
- `label_delete` знімає мітку з усіх задач.
- Повторний uuid Todoist ігнорує — на цьому тримається ідемпотентність ретраїв.

## Telegram — нюанси

- Підпис до медіа — 1024 символи, текст — 4096 (див. `fitCaption`, `CAPTION_MAX`, `TEXT_CAPTION_MAX`).
- Реакція ✍ — без U+FE0F, інакше `REACTION_INVALID`; ✏ для ботів недоступна (тому 👨‍💻).
- Бот не отримує власних дописів у каналі через вебхук.
- `getFile` — до 20 МБ; посилання на повідомлення є лише для чатів `-100…`.

## Agent skills

### Issue tracker

Задачі ведемо в GitHub Issues (`vichnyi-myzuka/voice-notes-worker`, через `gh`). Див. `docs/agents/issue-tracker.md`.

### Triage labels

Стандартні п'ять міток: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Див. `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` у корені. Див. `docs/agents/domain.md`.
