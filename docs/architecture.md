# Архітектура

Огляд системи з діаграмами. Ця сторінка першою відкривається на приватному сайті документації (`apps/docs`), який перебудовується після кожного мержу в `main`; діаграми тут пишемо в Mermaid. Змінив структуру чи потік даних: онови діаграму в тому ж PR.

## Загальна картина

```mermaid
flowchart LR
  owner([Власник])
  subgraph TG[Telegram]
    chan[Канал нотаток]
    chat[Чат з агентом]
  end
  subgraph CF[Cloudflare]
    notes[apps/notes<br/>воркер нотаток]
    agent[apps/agent<br/>воркер агента + Durable Object]
    cont[[Контейнер<br/>OpenCode + сесії]]
    sites[apps/sites<br/>приватні й публічні сайти]
    docs[apps/docs<br/>ця документація]
    r2[(R2)]
    q[[Queues]]
    ai[Workers AI]
  end
  todoist[Todoist]
  gh[GitHub]
  llm[OpenAI]

  owner -- голос, текст, фото --> chan --> notes
  owner -- завдання --> chat --> agent
  notes --> r2
  notes --> q
  notes --> ai
  notes --> llm
  notes --> todoist
  notes --> chan
  agent --> cont
  agent --> chat
  agent --> ai
  cont -- publish --> r2
  cont -- git, PR --> gh
  gh -- вебхуки --> agent
  r2 --> sites
  gh -- мерж у main --> docs
```

Три воркери (`notes`, `agent`, `sites`) і спільний код у `packages/*`; застосунки не залежать один від одного. Документація (`docs`) — окремий воркер зі статикою, зібраною з цього репозиторію.

## Нотатки: конвеєр обробки запису

```mermaid
sequenceDiagram
  participant U as Власник
  participant T as Telegram / Shortcut
  participant I as interface/inbox
  participant R as R2
  participant Q as Queue
  participant P as application/pipeline
  participant L as Llm (Whisper, gpt-6-luna)
  participant D as Todoist

  U->>T: голос / текст / фото
  T->>I: вебхук або POST
  I->>R: запис (аудіо, метадані)
  I->>Q: задача на обробку
  Q->>P: processNote
  P->>L: транскрипт, summary
  P->>D: тріаж задач, створення
  P->>T: публікація нотатки в каналі
  Note over P,R: кожен крок ідемпотентний,<br/>стан у key.state.json
  Q-->>T: після 4 невдач: DLQ і повідомлення про помилку
```

## Нотатки: шари

```mermaid
flowchart TB
  iface[interface<br/>inbox, queue]
  app[application<br/>intake, pipeline, understand,<br/>tasks, issues, setup]
  dom[domain<br/>note, published, recording, tracker]
  infra[infrastructure<br/>r2, todoist, env]
  core[packages/core<br/>Channel, Llm, openSteps]

  iface --> app --> dom
  infra -. реалізує порти .-> dom
  app --> core
  infra --> core
```

Ядро (`interface`, `application`, `domain`) не знає про Telegram і Todoist, лише про порти: `Channel`, `Llm`, `TaskTracker`, `NoteRepository`, `TaskLedger`, `RecordingStore`. Адаптери складаються в `src/index.ts`.

## Агент: від повідомлення до PR

```mermaid
sequenceDiagram
  participant U as Власник
  participant T as interface/telegram
  participant A as Agent (порт)
  participant DO as Durable Object main
  participant C as Контейнер (OpenCode)
  participant G as GitHub

  U->>T: завдання (текст або голос)
  T->>T: вибір репозиторію й назви сесії
  T->>A: start
  A->>DO: сесія
  DO->>C: session-prep (git worktree)
  DO->>C: prompt у OpenCode
  C->>G: push agent/назва, PR
  C-->>DO: події інструментів
  DO-->>T: пост оновлюється на місці
  G-->>T: вебхук: мерж, відкликання PR, CI
```

## Агент: модулі

```mermaid
flowchart TB
  subgraph interface
    tg[telegram]
    ghh[github]
    http[http]
  end
  chatm[infrastructure/chat<br/>пости, callback_data, повідомлення]
  port[domain/agent<br/>Agent = Sessions &amp; Computer &amp; Deploys]
  cont[infrastructure/container<br/>Durable Object AgentSession + контейнер]
  ghi[infrastructure/github]

  tg --> chatm
  ghh --> chatm
  tg --> port
  ghh --> port
  http --> port
  cont -. реалізує .-> port
  ghh --> ghi
```

Interface-модулі не залежать один від одного (ADR 0004). Один Durable Object і один контейнер на всі сесії (ADR 0001).

## Сайти агента

```mermaid
flowchart LR
  a[Агент у контейнері] -- publish --> b1[(R2 agent-sites)]
  a -- publish --public --> b2[(R2 agent-sites-public)]
  b1 --> s[sites.домен<br/>Cloudflare Access]
  b2 --> p[share.домен<br/>без Access]
```

## CI/CD

```mermaid
flowchart LR
  pr[PR агента] --> chk[check: lint, tsc, vitest]
  chk --> merge[мерж у main]
  merge --> dep[deploy: лише змінені застосунки]
  dep --> n[notes]
  dep --> s[sites]
  dep --> d[docs]
  dep --> ap{{схвалення власника}} --> ag[agent]
```

Нижче на сторінці «Знімок коду» видно актуальну структуру модулів і прив'язки кожного воркера, згенеровані з репозиторію під час збірки.
