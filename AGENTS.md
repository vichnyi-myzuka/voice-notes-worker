# AGENTS.md

Правила роботи з репозиторієм для агентів. Як працює бот, описано в `README.md`; тут лише те, чого з README не видно.

## Робочий цикл

- Перед комітом: `npm run check` (oxlint + tsc + vitest). Git-хуки однаково запускають pre-commit (lint + typecheck) і pre-push (`npm run check`).
- **Після коміту одразу `git push origin main` і `npx wrangler deploy`.** Якщо wrangler просить авторизацію, попроси користувача виконати `npx wrangler login`.
- Зміна поведінки → онови README в тому ж коміті. Нова логіка → unit-тести в `test/` (без мережі й LLM; `fetch` підміняється через `vi.stubGlobal`, R2 — `test/fake-env.ts`).

## Секрети

- Значень секретів ніколи не друкуй і не вигадуй. `source .env` у shell можна, `echo $TOKEN` — ні.
- Секрети воркера: `wrangler secret put`. Локально wrangler бере їх з `.env`.

## Стиль

- Просто, мінімум абстракцій; невеликі функції поруч з місцем використання. Альтернативні підходи — коротко згадай користувачу, а не впроваджуй мовчки.
- Коментарі в коді, тексти для користувача, промпти щодо результату — українською (самі системні промпти — англійською).
- Нотатки в Telegram: назва, summary, «💡 Ключові думки», «✅ Задачі», маркери «•», порожні секції не показуються, транскрипт не публікується.
- Обробка в черзі ідемпотентна: проміжний стан у R2 (`<key>.state.json`), команди Todoist зі сталими uuid. Нові кроки конвеєра додавай так само (`step("поле", fn, { onFinalFailure })` з `openSteps`; на `lastAttempt` — деградувати, а не падати).

## Код

Модуль — папка; зовні імпортуй лише з `index.ts` модуля (`../tasks`), усередині — з файлів (`./apply`). Стан обробки складається зі слайсів модулів (`SyncState`, `SetupState`, `ContentState`, `PublishState`) у `pipeline/types.ts`.

```
src/index.ts           entrypoint: лише підключає fetch (inbox) і queue (queue)
src/<модуль>/          кожен модуль — папка: index.ts (публічний інтерфейс), types.ts за потреби і кілька змістовних файлів з логікою (без файлів на одну константу чи функцію)
  env/                 Env і Job
  inbox/               прийом записів: вебхук Telegram і завантаження з шорткату → R2 + черга
  queue/               споживачі черги й DLQ
  pipeline/            processNote / processEdit — кроки обробки запису; State зі слайсів модулів
  steps/               openSteps: крок = поле стану, результат у R2, onFinalFailure для деградації на lastAttempt
  recording/           ключі запису в R2, ліміти розміру, час запису
  understand/          transcribe (Whisper), readImage (vision), summarize, editNote — промпти й схеми
  llm/                 askJson: structured output gpt-6-luna → fallback Gemma 4 (Workers AI)
  note/                чиста логіка нотатки: Meta, підпис, хештеги, посилання на задачі, текстові нотатки
  published/           опублікована нотатка: Note, ключі R2 notes/…, saveNote / loadNote / showNote / removeNote
  todoist/             знімок Todoist, валідація полів задач, тріаж
  tasks/               задачі нотатки в Todoist: syncTasks (ops → actionId → todoistApplied), planOps / buildCommands / applyOps, стан InTodoist, вкладення
  setup/               команди налаштування («створи проєкт…», описи міток у «⚙️ Правила»), runSetup
  telegram/            Bot API, прийом голосових / тексту / фото з вебхука, реакції
```

## Локальний e2e (справжній канал і Todoist!)

```sh
npx wrangler dev --port 8787 --var LOCAL_DEV:1 --var TG_OWNER_ID:230295237 --var TG_WEBHOOK_SECRET:local-webhook-test
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
