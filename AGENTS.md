# AGENTS.md

Правила роботи з репозиторієм для агентів. Репозиторій — моно-репо на npm workspaces: `apps/*` (воркери: `apps/notes` — нотатки, `apps/agent` — спільний контейнер з OpenCode і сесії агента в ньому, `apps/sites` — віддача статичних сайтів агента з R2), `packages/*` (спільний код). Застосунки залежать від пакетів, але не один від одного; пакет імпортується лише через свій `index.ts`. Як працює бот, описано в `README.md`; тут лише те, чого з README не видно.

## Робочий цикл

- Перед комітом: `npm run check` (oxlint + tsc + vitest). Git-хуки однаково запускають pre-commit (lint + typecheck) і pre-push (`npm run check`).
- **Зміни йдуть через PR, деплоїть GitHub Actions** (`.github/workflows`): PR → `check` → мерж у `main` → `deploy` змінених застосунків (`agent` чекає схвалення власника в environment `production-agent`). Агент пушить лише у свою гілку `agent/<назва>` і відкриває PR; у `main` не пушить, `wrangler deploy` не запускає, `.github/` не чіпає. Локальний `npm run deploy -w apps/<назва>` лишається лише власнику для аварійних випадків (`npx wrangler login`). Кроки налаштування GitHub: розділ «CI/CD» у README.
- Зміна поведінки → онови README або відповідний файл у `docs/` (`notes`, `agent*`, `cloudflare`) в тому ж коміті. Нова логіка → unit-тести в `test/` відповідного застосунку (без мережі й LLM; `fetch` підміняється через `vi.stubGlobal`, R2 — `test/fake-env.ts`). Зміна наскрізної поведінки → перевір `apps/notes/test/e2e.test.ts` (повний цикл на моках, без реальних сервісів).

- PR, що змінює структуру (нові/видалені/перейменовані застосунки, пакети, модулі, порти чи зв'язки між ними), мусить зачіпати `apps/docs/web/src/diagrams.tsx` або `apps/docs/web/src/content.ts`, щоб сайт архітектури не застарів.

## Секрети

- Значень секретів ніколи не друкуй і не вигадуй. `source .env` у shell можна, `echo $TOKEN` — ні.
- Секрети воркера: `wrangler secret put` (з теки застосунку). Локально `npm run dev` бере їх з `.env` у корені (`--env-file ../../.env`).

## Стиль

- Просто, мінімум абстракцій; невеликі функції поруч з місцем використання. Альтернативні підходи — коротко згадай користувачу, а не впроваджуй мовчки.
- Коментарі в коді, тексти для користувача, промпти щодо результату — українською (самі системні промпти — англійською).
- Нотатки в Telegram: назва, summary, «💡 Ключові думки», «✅ Задачі», маркери «•», порожні секції не показуються, транскрипт не публікується.
- Обробка в черзі ідемпотентна: проміжний стан у R2 (`<key>.state.json`), команди Todoist зі сталими uuid. Нові кроки конвеєра додавай так само (`step("поле", fn, { onFinalFailure })` з `openSteps`; на `lastAttempt` — деградувати, а не падати).

## Код

Структура: `apps/*` (воркери) залежать від `packages/*`, але не один від одного. Де що лежить — дивись `ls`, README і `docs/`; тут лише правила.

- **Шари** (`apps/notes/src`): `interface → application → domain`, `infrastructure` реалізує порти з `domain`. Складання адаптерів — у `src/index.ts`.
- **Ядро нічого не знає про Telegram і Todoist.** Воно працює з портами `Channel`, `Llm` (`packages/core`), `TaskTracker`, `NoteRepository`, `TaskLedger`, `RecordingStore` (`domain`). Службові дані каналу (`fileId`, `deleteChatId`…) лежать у `customMetadata` запису в R2, ядро передає їх каналу як є.
- **Модуль — папка з `index.ts`.** Зовні імпортуй лише з `index.ts` (`../tasks`, а не `../tasks/apply`), пакет core — лише `@voice-notes/core`. Це перевіряє `.oxlintrc.json` (`npm run lint`); тести можуть імпортувати глибше. У тестах мок внутрішнього модуля core робиться за шляхом файлу в `packages/core/src`.
- **Стан обробки** складається зі слайсів модулів (`SyncState`, `SetupState`, `ContentState`, `PublishState`) у `application/pipeline/types.ts`.
- **`apps/agent`**: порт `Agent = Sessions & Computer & Deploys`; один Durable Object `main` з єдиним контейнером (`infrastructure/container`); interface-модулі (`telegram`, `github`, `http`) не залежать один від одного, спільне — в `infrastructure/chat` (ADR 0004). Образ контейнера (`container/`) — лише системне; усе, що змінюється часто (AGENTS.md агента, `publish`, хуки), лежить у `payload/` і розкладається воркером. Тести — з фейком `test/fake-agent.ts`.

## Довідники

- Нюанси API Todoist і Telegram: `docs/agents/api-notes.md`.
- Локальний e2e зі справжнім каналом і Todoist (створює реальні дані!): `docs/agents/local-e2e.md`.

## Agent skills

### Issue tracker

Задачі ведемо в GitHub Issues (`vichnyi-myzuka/voice-notes-worker`, через `gh`). Див. `docs/agents/issue-tracker.md`.

### Triage labels

Стандартні п'ять міток: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Див. `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` у корені. Див. `docs/agents/domain.md`.
