# План рефакторингу `apps/agent`

Мета: розібрати `AgentSession` (`infrastructure/container/session.ts`, ~840 рядків, сім ролей в одному класі) на модулі з однією
відповідальністю, не змінюючи поведінки. Клас Durable Object лишається `AgentSession` (перейменування потребує міграції, ADR 0001),
формат ключів у сховищі не змінюється (дані наявних сесій читаються як раніше). Кожен крок — окремий коміт, після кожного
`npm run check` зелений.

## Етап 1: розбиття `AgentSession`

1. [x] **`SessionStore`** (`store.ts`): типізований доступ до записів `session:`, `watch:`, `job:`, `limit:` і пошук сесії за id
   OpenCode, темою чи гілкою. Прибирає дубльовані `storage.list(...).find(...)` із `session.ts` і `posts.ts`.
2. [x] **`Limits`** (`limits.ts`): очікування скидання лімітів Claude (`waitForLimits`, `checkLimits`).
   - [x] *Поза планом, на прохання власника:* прибрано вигляд теми `messages` (`thread-ui.ts`, клавіші внизу теми, `keyView`,
     `pendingReview`, табло, «➕ Нова сесія», `THREAD_UI`, Flagship). Лишився лише classic.
3. [x] **`Mcp`** (`mcp.ts`): входи OAuth (Сільпо, Календар, Cloudflare), токени для конфігу теки, оновлення токенів у живому
   OpenCode, запит MCP агентом і відповідь власника.
4. [x] **`Jobs`** (`jobs.ts`): черга прийнятих завдань (`begin`, `resume`, повтори, звіт про збій).
5. [x] **`Progress`** (`progress.ts`): що бачить власник під час роботи: опис поточної дії, питання агента, іконка й назва теми.
6. [x] **`Watcher`** (`watcher.ts`): стеження за сесіями (опитування, потік подій OpenCode, ліміти вартості, підсумок).
7. [x] **Фасад**: в `AgentSession` лишаються RPC-методи порту `Agent`, `alarm` і складання модулів. Оновити ADR 0001, `docs/agent.md`
   і сайт документації (`apps/docs/web/src/content.ts`, `diagrams.tsx`).

## Етап 2 (окремими PR, після етапу 1)

- [x] Єдиний реєстр MCP-сервісів (`domain/agent/mcp.ts`, `MCP_SERVICES`; решта шарів тримає дані як `Record<McpName, …>`): назва, підпис, промпт, вхід, «вміє змінювати дані». Зараз сервіс додається в ~10 місцях
  (`McpName`, `Tracked`, `StartInput`, `parsePrefixes`, `mcpConfig`, `start`, логіни, HTTP-маршрути).
- [x] HTTP: одна функція для маршрутів OAuth замість трьох копій; прибрано дубль `/sw.js`; веб-запити (`POST /api/sessions`, `…/messages`) йдуть через чергу завдань (`begin`/`resume` без чату), як у чаті.
- [x] `Computer`: підготовку тек і MCP-конфігів (`prepare`, `enableMcp`) винесено в `Workspace` (`workspace.ts`); ключі сховища контейнера — `computerKey` у `state.ts`.
- [x] `Env` розділено на групи (`AccessEnv`, `ContainerEnv`, `ChatEnv`, `GithubEnv`, `PublishEnv`, `McpEnv` у `env.ts`); модулі просять лише свою групу.
- [x] `chat`: id сесії в кнопках передається явно (`SessionLink { id, url }`), а не добувається з URL.
- [x] `application/task` для агента: вибір репозиторію, моделі й MCP (`planTask`, префікси, роутер) винесено з `interface/telegram/handle.ts`; interface лишає лише Telegram.
- [x] Правила лінтера на напрямок шарів (`.oxlintrc.json`): `domain` не імпортує інші шари; `application` агента не імпортує `infrastructure` і `interface`; `interface` не імпортує `infrastructure/container` (до Durable Object лише через порт `Agent`). Спільні адаптери `infrastructure/chat`, `github`, `quota` дозволені (ADR 0004). Для `apps/notes` правило додано на етапі 3.
- [x] Шаблон report-site — тека `payload/report-site/` з `.tpl`-файлами замість heredoc у `new-report-site.sh`; список файлів — `infrastructure/container/computer/report-site.ts` (тест звіряє його з диском).

## Етап 3 (окремим PR, після етапу 2)

- [x] `apps/notes`: типи `Env` і `Job` винесено з `infrastructure/env` в `application/env`, щоб `application` не імпортував `infrastructure`.
- [x] Поширити правило лінтера на напрямок шарів (`.oxlintrc.json`) на `apps/notes/src/application/**` (`application` не імпортує `infrastructure` і `interface`), перевірити навмисним порушенням.
- [x] Оновити `docs/agent-refactor.md` (цей файл) і сайт архітектури (`apps/docs/web/src/diagrams.tsx` або `content.ts`), якщо зміниться структура модулів.

## Етап 4: ядро агента в `application` через порти

Мета: у `infrastructure/container` лишаються лише адаптери (Durable Object, контейнер, OpenCode, Telegram, GitHub, OAuth), а оркестрація й правила живуть в `application/*` і торкаються зовнішнього світу тільки через порти `domain/agent/ports.ts`. Поведінка, ключі сховища й клас `AgentSession` не змінюються. Кожен крок — окремий коміт, після кожного `npm run check` зелений. Лінтер уже забороняє `application` агента імпортувати `infrastructure` і `interface`, тож порушення покаже `npm run lint`.

Зроблено:

- [x] `infrastructure/container` розкладено по теках `state`, `opencode`, `logins`, `computer`, `mcp`, `progress`, `jobs` (кожна з `index.ts`, назовні імпорт лише через нього).
- [x] Порти `SessionStore`, `Scheduler`, `Notices`, `LimitProbe` (`domain/agent/ports.ts`), типи записів `Job`, `Watch`, `Tracked`, `LimitWait` (`domain/agent/records.ts`). Адаптери — `container/adapters.ts` (`durableScheduler`, `chatNotices`, `claudeLimits`), `SessionStore` на сховищі DO — `state/store.ts`.
- [x] В `application` перенесено `Jobs` і `Limits` (`application/jobs`, разом із політикою повторів `policy.ts`), чисті `activity`, `narrate`, `title` (`application/progress`), розбір `set-repo` (`application/watch`), розбір з'єднань (`application/computer`), `extractImages` з лімітами (`application/progress/images.ts`). Тести на фейках у пам'яті: `test/fake-ports.ts`, `test/jobs.test.ts`.

- [x] Порти `OpencodeClient` (клієнт OpenCode: запити, форми, стан, потік подій) і `PostBoard` (пост сесії); типи подій OpenCode, `PendingForm`, `Choice` підняті в `domain/agent/records.ts`; адаптер `opencodeClient`.
- [x] `Forms` в `application/progress` (форми — у `SessionStore`: `form`, `saveForm`, `dropForm`, `forms`), тести `test/forms.test.ts`.
- [x] `Progress` в `application/progress` (залежності: `Llm`, `PostBoard`, `Forms`, `SessionStore`), тести `test/progress.test.ts`.
- [x] `Posts` розділено: правила в `application/progress/posts.ts` (кнопки, шапка, деплой, іконка), адаптери — порти `PostChat` (Telegram: `infrastructure/container/progress/telegram-posts.ts`) і `PostStore` (`state/post-store.ts`); тести `test/posts.test.ts`.
- [x] `Mcp` (запит агента й відповідь власника) в `application/mcp` через порт `McpAccess` і `Notices.askMcp`; токени, входи й оновлення в живому OpenCode — адаптер `McpServers` (`container/mcp`); тести в `test/mcp.test.ts`.
- [x] `Watcher` в `application/watch` через порти `Container`, `PullRequests`, `HandoffSpawner`, `Notices` (`send` з `mergeable`, `images`), `PostStore`, `Scheduler`; розбір `handoff` і `isLimitError` теж в `application`; тести `test/watcher.test.ts`.
- [x] `session.ts` — фасад: RPC-методи порту `Agent`, `alarm`, складання адаптерів і модулів; `docs/agent.md`, ADR 0001, цей файл, `content.ts` і `diagrams.tsx` оновлено.

Етап 4 завершено. Не переносилось (лишається адаптерами в `infrastructure/container`): `Computer`, `Workspace`, `WebProxy`, `payload`, `logins`, `Handoffs` (створення теми й поста в чаті), HTTP-клієнт OpenCode, `SessionStore`/`PostRecords` на сховищі DO. Окремий нюанс: `Posts` імпортує лише розмітку цитат з `@voice-notes/telegram-format`, інших залежностей від Telegram в `application` немає.

Підказки: файли переносить скрипт-перейменування імпортів за шаблоном «старий шлях → новий» (`git mv` + виправлення `import`, модуль імпортується лише через `index.ts` своєї теки, тести можуть імпортувати глибше); `export *` в `index.ts` теки відкриває все, що експортують її файли, тож можна звузити до потрібних імен.
