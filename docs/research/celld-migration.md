# Дослідження: переїзд інфраструктури на celld

Дата: 2026-11-14. Версія celld: v0.6.2 (beta). Джерела: [celld.dev/docs](https://celld.dev/docs), [сумісність з Cloudflare](https://celld.dev/docs/cloudflare-compat), [Containers](https://celld.dev/docs/services/containers), [Limitations](https://celld.dev/docs/limitations), [R2](https://celld.dev/docs/services/r2), [Queues](https://celld.dev/docs/services/queues).

## Що таке celld

Демон від Deno (Rust + V8, Apache-2.0), що запускає Workers-застосунок на власних машинах із нашого конфігу wrangler. Durable Object у ньому називається «cell» і має власну SQLite. Довгостроковий стан лежить в S3-сумісному бакеті (підходить і R2). Вузли (`celld`-процеси на VM), що ділять бакет, утворюють fleet. Власність cell визначається умовним записом у бакет, тому окремого control plane немає. Підтримуються Workers, DO, Queues, R2, KV, D1, Cron, static assets. Containers мають статус **Experimental**. **Workers AI** не підтримується.

## Висновок

Технічно переїхати можна, але це не просто «перенести wrangler.toml». Оцінка — **близько 2–3 тижнів роботи плюс постійна експлуатація своїх VM**. Найдорожче коштує агент: у celld немає знімків диска контейнера, на яких тримається вся модель сесій, а контейнери поки експериментальні. `notes`, `sites` і `docs` переносяться порівняно легко (кілька днів), але їх ми не переносимо одні: у них є Workers AI і Access.

Рекомендація: **зараз не переїжджати**. Celld у beta, контейнери в ньому експериментальні, а конкретної проблеми (ціна, ліміти), яку переїзд мав би розв'язати, ми не маємо. Варто повернутися до питання, коли контейнери стануть стабільними або з'явиться причина піти з Cloudflare. Якщо мета — дешевший або потужніший контейнер для агента, дешевше винести на VM лише контейнер, а не всю платформу.

## Що ламається і що з цим робити

Позначки: 🔴 блокер, без переробки не працює; 🟠 помітна робота; 🟢 дрібниця.

### 🔴 Знімки диска агента (`apps/agent`)

`infrastructure/container/computer.ts` зберігає диск через `ctx.container.snapshotContainer()` і запускає контейнер з `start({ containerSnapshot, image, instance })`. У celld `snapshotContainer()`/`snapshotDirectory()` відхиляються з помилкою, а `start()` приймає лише `entrypoint`, `env`, `enableInternet`, `labels`. Диск контейнера ефемерний: переїзд cell на інший вузол, рестарт або оновлення вузла знищує контейнер.

Що робити: власне збереження `/workspace` (і бази OpenCode) у бакет, наприклад `restic`/`rclone` з контейнера на alarm, коли агенти вільні, і відновлення в `entrypoint.sh` перед стартом OpenCode. Ще треба перенести `instance_type` (зараз `standard-1` у коді) у конфіг, переписати `/update` і `/snapshot`, оновити ADR 0001 і `payload/AGENTS.md`. Оцінка: 3–5 днів плюс ризик. Знімок git-воркдерев і `node_modules` займає сотні МБ, тому відновлення буде повільнішим, ніж зараз.

### 🔴 Workers AI (`packages/core/src/infrastructure/llm`)

Whisper (`@cf/openai/whisper-large-v3-turbo`) для голосових у notes і agent, а також резервна Gemma (`ask.ts`) працюють через binding `AI`, якого в celld немає.

Що робити: адаптер на зовнішній HTTP API (OpenAI/Groq Whisper або self-hosted faster-whisper; Gemma замінити іншою моделлю), нові секрети, тести з підміною `fetch`. Оцінка: 1–2 дні. З'являються витрати: зараз нас покриває безкоштовна квота 10 000 neurons на день.

### 🟠 Ingress, TLS, домени, Cloudflare Access

Celld не термінує TLS, не має керованого ingress і custom domains. Ми зараз маємо домени `notes.`, `agent.`, `sites.`, `share.`, `docs.` з `wrangler deploy --domain`. Для `agent.`, `sites.` і `docs.` код перевіряє JWT Access (`packages/core/src/infrastructure/access`), а вебхуки обходять Access (ADR 0003).

Найпростіше: лишити DNS у Cloudflare і пустити трафік через Cloudflare Tunnel (`cloudflared` на VM). Тоді Access і перевірка JWT працюють без змін, а правила обходу для вебхуків переносяться в налаштування Access. Повний відхід від Cloudflare потребує заміни Access (oauth2-proxy чи подібне), а це ще 2–3 дні. Оцінка з тунелем: 1 день.

### 🟠 Конфіги wrangler

Celld читає лише `wrangler.json(c)`, не `.toml`, і зупиняється на невідомому ключі. Треба перевести 4 конфіги й прибрати або замінити `ai`, `observability`, `exports`, `workers_dev`, `preview_urls`, `env.public` (окремий конфіг для публічних сайтів), `containers.authorized_keys`, `scheduling_policy`, `images.base`. Крім того, «a fleet runs one application», тож, імовірно, кожному застосунку (notes, agent, sites, sites-public, docs) потрібен власний fleet: окремий бакет чи префікс і окремий набір процесів. Це треба перевірити на практиці. Оцінка: 1 день.

### 🟠 Перенесення даних

- R2: celld зберігає об'єкти binding'а як `r2/<bucket_name>/<key>` у бакеті fleet, частину символів кодує відсотками. Наявні `voice-notes`, `agent-sites`, `agent-sites-public` треба скопіювати під новий префікс.
- `publish` (`payload/publish.sh`) пише в R2 напряму через S3 і rclone. У celld немає S3-ендпоінта для binding'ів, а кодування ключів rclone не збігається з celld. Тому краще пустити `publish` через API воркера `sites`. Оцінка: 1 день.
- Стан Durable Objects (сесії агента, пости, форми, OAuth-токени, `packages/oauth`) автоматично не переноситься. Або пишемо експорт/імпорт, або приймаємо скидання, як після `/update`, і заново логінимось в OAuth.
- Черги: перед перемиканням дочекатися, поки `voice-notes` і DLQ спорожніють. Налаштування consumer (`max_batch_size`, `max_retries`, `retry_delay`, DLQ) celld підтримує.

### 🟠 CI/CD і спостережуваність

- `.github/workflows` замість `wrangler deploy` має викликати `celld deploy` з ключами бакета fleet. Workflows змінює лише власник, у агента немає на це прав.
- Зникнуть Workers Logs і трейси з дашборду. Знадобляться journald або свій збирач (у celld є [Telemetry](https://celld.dev/docs/telemetry)), а `npm run cost` втратить сенс.

### 🟢 Що працює без змін

Workers `fetch`, Durable Objects (KV-API storage, alarms), `ctx.waitUntil`, Queues з DLQ, static assets (`apps/docs`), `ctx.container.exec()` і `getTcpPort().fetch()` (проксі до OpenCode), Web Crypto для JWT (RS256). Unit-тести працюють на фейках і від рантайму не залежать.

## Експлуатація (нове для нас)

- VM: на одному вузлі кожен запис чекає бакет («much slower»). Для нормальної швидкості потрібні щонайменше 2 вузли, а Docker для агента потрібен на кожному вузлі, що обслуговує клас із контейнером.
- Supervisor (systemd), оновлення celld, Docker і ОС, бекапи, моніторинг дисків.
- Безпека: агент виконує довільний код як root з інтернетом. На стандартному runtime контейнер ділить ядро з вузлом, тому варто ставити gVisor чи Kata (`CELLD_CONTAINER_RUNTIME`). Трафік між вузлами йде відкритим HTTP, тож потрібна приватна мережа або WireGuard.
- Вартість: VM на 8 ГБ коштує близько $48/міс (дві — близько $96), плюс бакет і API для Whisper. Це варто порівняти з нашими поточними витратами на Cloudflare (`npm run cost`), які на нашому масштабі, найімовірніше, менші.

## Сумарна оцінка

| Блок | Оцінка |
|---|---|
| Знімки диска агента | 3–5 днів |
| Workers AI → зовнішній API | 1–2 дні |
| Конфіги wrangler → jsonc, fleets | 1 день |
| Ingress через Cloudflare Tunnel | 1 день (+2–3 без Access) |
| Дані R2, `publish`, стан DO | 2 дні |
| CI/CD, логи, VM, gVisor, перемикання | 3–4 дні |
| **Разом** | **~2–3 тижні** плюс постійна підтримка VM |

## Якщо колись вирішимо

1. Пілот: `celld dev` локально з `apps/sites` і `apps/docs` (без AI і контейнерів), щоб перевірити конфіги й поведінку кількох fleet.
2. Абстрагувати транскрипцію від binding'а `AI`. Це корисно й без celld, бо дає резервного провайдера.
3. Прототип агента на celld із власним бекапом `/workspace` на одній VM з gVisor.
4. Лише потім переносити дані й перемикати DNS через Tunnel.
