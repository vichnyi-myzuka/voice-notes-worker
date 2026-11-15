import { Arrow, Box, DiagramCard } from "./components/Diagram";

// Схеми архітектури зібрані вручну з Box і Arrow (кольори лише через series). Змінив структуру: онови схему тут.
// Рядки в Box мають бути короткими (~28 символів на 190 px).

export function Overview() {
  return (
    <DiagramCard title="Загальна картина" description="Хто з ким спілкується: Telegram, воркери Cloudflare й зовнішні сервіси" viewBox="0 0 960 480" className="lg:col-span-2">
      <Box x={20} y={170} w={150} h={70} title="Власник" lines={["Telegram, Shortcut"]} color={4} />
      <Box x={230} y={60} w={170} h={70} title="Канал нотаток" lines={["голос, текст, фото"]} color={4} />
      <Box x={230} y={300} w={170} h={80} title="Чат з агентом" lines={["завдання, кнопки", "пост на сесію"]} color={4} />
      <Box x={480} y={50} w={200} h={90} title="apps/notes" lines={["воркер нотаток", "R2, Queue, DLQ"]} color={0} />
      <Box x={480} y={300} w={200} h={80} title="apps/agent" lines={["Durable Object main", "сесії й стеження"]} color={1} />
      <Box x={740} y={50} w={200} h={70} title="Todoist" lines={["задачі, тріаж"]} color={3} />
      <Box x={740} y={140} w={200} h={70} title="Whisper, gpt-6-luna" lines={["Workers AI, OpenAI"]} color={3} />
      <Box x={740} y={225} w={200} h={60} title="apps/sites" lines={["приватні й публічні сайти"]} color={2} />
      <Box x={740} y={300} w={200} h={80} title="Контейнер" lines={["OpenCode, git worktree", "один на всі сесії"]} color={1} />
      <Box x={740} y={410} w={200} h={60} title="GitHub" lines={["гілки, PR, вебхуки"]} color={3} />
      <Arrow points={[[170, 190], [200, 190], [200, 95], [230, 95]]} />
      <Arrow points={[[170, 220], [200, 220], [200, 340], [230, 340]]} />
      <Arrow points={[[400, 95], [480, 95]]} label="вебхук" both />
      <Arrow points={[[400, 340], [480, 340]]} label="завдання" both />
      <Arrow points={[[680, 85], [740, 85]]} />
      <Arrow points={[[640, 140], [640, 175], [740, 175]]} />
      <Arrow points={[[680, 340], [740, 340]]} />
      <Arrow points={[[840, 300], [840, 285]]} label="publish" labelAt={[890, 296]} dashed />
      <Arrow points={[[840, 380], [840, 410]]} label="git, PR" labelAt={[885, 400]} />
      <Arrow points={[[740, 440], [580, 440], [580, 380]]} label="вебхуки" labelAt={[660, 432]} dashed />
    </DiagramCard>
  );
}

export function NotesPipeline() {
  return (
    <DiagramCard title="Нотатки: конвеєр запису" description="Від голосу до нотатки в каналі й задач у Todoist" viewBox="0 0 960 310">
      <Box x={20} y={30} w={190} h={80} title="Вхід" lines={["вебхук Telegram", "POST із Shortcut"]} color={4} />
      <Box x={265} y={30} w={190} h={80} title="R2 і Queue" lines={["запис і метадані", "задача на обробку"]} color={0} />
      <Box x={510} y={30} w={190} h={80} title="processNote" lines={["Whisper: транскрипт", "gpt-6-luna: summary"]} color={1} />
      <Box x={755} y={30} w={185} h={80} title="Todoist" lines={["тріаж задач", "створення задач"]} color={3} />
      <Box x={755} y={200} w={185} h={80} title="Telegram" lines={["публікація нотатки", "підпис із посиланнями"]} color={4} />
      <Box x={510} y={200} w={190} h={80} title="DLQ" lines={["після 4 невдач", "повідомлення про збій"]} color={4} dashed />
      <Box x={265} y={200} w={190} h={80} title="Стан кроків" lines={["key.state.json у R2", "кроки ідемпотентні"]} color={2} />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} />
      <Arrow points={[[700, 70], [755, 70]]} />
      <Arrow points={[[847, 110], [847, 200]]} label="підпис" labelAt={[885, 160]} />
      <Arrow points={[[605, 110], [605, 200]]} label="збої" labelAt={[632, 160]} dashed />
      <Arrow points={[[360, 200], [360, 110]]} label="стан" labelAt={[385, 160]} dashed both />
    </DiagramCard>
  );
}

export function NotesLayers() {
  return (
    <DiagramCard title="Нотатки: шари" description="Залежності йдуть згори вниз; інфраструктура реалізує порти домену" viewBox="0 0 960 350">
      <Box x={20} y={140} w={220} h={80} title="packages/core" lines={["Channel, Llm, openSteps", "адаптери Telegram і Llm"]} color={2} />
      <Box x={280} y={20} w={400} h={80} title="interface" lines={["inbox: вебхук і завантаження", "queue: споживачі й DLQ"]} color={0} />
      <Box x={280} y={140} w={400} h={80} title="application" lines={["intake, pipeline, understand", "tasks, issues, setup"]} color={0} />
      <Box x={280} y={250} w={400} h={80} title="domain" lines={["note, published, recording, tracker", "порти: TaskTracker, NoteRepository…"]} color={0} />
      <Box x={720} y={140} w={220} h={80} title="infrastructure" lines={["r2, todoist", "адаптери портів"]} color={1} />
      <Arrow points={[[480, 100], [480, 140]]} />
      <Arrow points={[[480, 220], [480, 250]]} />
      <Arrow points={[[280, 180], [240, 180]]} />
      <Arrow points={[[830, 220], [830, 290], [680, 290]]} label="реалізує порти" labelAt={[755, 282]} dashed />
    </DiagramCard>
  );
}

export function AgentFlow() {
  return (
    <DiagramCard title="Агент: від повідомлення до PR" description="Що відбувається після завдання в чаті" viewBox="0 0 960 310">
      <Box x={20} y={30} w={190} h={80} title="Чат у Telegram" lines={["текст або голос"]} color={4} />
      <Box x={265} y={30} w={190} h={80} title="interface/telegram" lines={["команди, кнопки", "вибір сесії → application/task"]} color={0} />
      <Box x={510} y={30} w={190} h={80} title="AgentSession" lines={["Durable Object main", "session-prep"]} color={1} />
      <Box x={755} y={30} w={185} h={80} title="Контейнер" lines={["OpenCode", "worktree agent/назва"]} color={1} />
      <Box x={755} y={200} w={185} h={80} title="GitHub" lines={["push, PR, CI", "мерж у main"]} color={3} />
      <Box x={510} y={200} w={190} h={80} title="interface/github" lines={["вебхуки: мерж, CI, рев'ю"]} color={0} />
      <Box x={265} y={200} w={190} h={80} title="Пост у чаті" lines={["оновлюється на місці", "⏳ Працює → готово"]} color={4} />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} label="start" />
      <Arrow points={[[700, 70], [755, 70]]} label="prompt" />
      <Arrow points={[[847, 110], [847, 200]]} label="push, PR" labelAt={[893, 160]} />
      <Arrow points={[[755, 240], [700, 240]]} label="вебхук" labelAt={[728, 232]} />
      <Arrow points={[[510, 240], [455, 240]]} />
      <Arrow points={[[360, 200], [360, 110]]} label="оновлення" labelAt={[400, 160]} dashed />
    </DiagramCard>
  );
}

export function AgentModules() {
  return (
    <DiagramCard title="Агент: модулі" description="Interface-модулі не залежать один від одного (ADR 0004)" viewBox="0 0 960 400">
      <Box x={20} y={20} w={200} h={70} title="interface/telegram" lines={["команди, кнопки, Whisper"]} color={0} />
      <Box x={280} y={20} w={200} h={70} title="interface/github" lines={["вебхуки, рев'ю, мерж"]} color={0} />
      <Box x={540} y={20} w={200} h={70} title="interface/http" lines={["REST API, проксі OpenCode"]} color={0} />
      <Box x={780} y={20} w={160} h={70} title="interface/managed-bots" lines={["PoC: боти-сесії"]} color={0} />
      <Box x={140} y={100} w={220} h={50} title="application/task" lines={["репозиторій, модель, MCP"]} color={1} />
      <Box x={20} y={160} w={460} h={80} title="infrastructure/chat" lines={["пости, клавіатури, callback_data,", "дії над повідомленнями"]} color={2} />
      <Box x={540} y={160} w={400} h={80} title="domain/agent (порт Agent)" lines={["Sessions & Computer & Deploys", "кожен модуль бере лише потрібне"]} color={1} />
      <Box x={540} y={300} w={400} h={80} title="infrastructure/container" lines={["AgentSession — фасад; лише адаптери портів", "ядро (Jobs, Watcher, Posts, Forms, Mcp) в application"]} color={1} />
      <Arrow points={[[120, 90], [120, 160]]} />
      <Arrow points={[[380, 90], [380, 160]]} />
      <Arrow points={[[640, 90], [640, 160]]} />
      <Arrow points={[[480, 200], [540, 200]]} label="Deploys" labelAt={[510, 192]} />
      <Arrow points={[[740, 300], [740, 240]]} label="реалізує" labelAt={[785, 275]} dashed />
    </DiagramCard>
  );
}

export function SitesFlow() {
  return (
    <DiagramCard title="Сайти агента" description="Приватні сайти за Access, публічні на окремому хості" viewBox="0 0 960 240">
      <Box x={20} y={40} w={200} h={80} title="Агент у контейнері" lines={["publish <тека> <назва>"]} color={1} />
      <Box x={330} y={20} w={230} h={70} title="R2 agent-sites" lines={["приватні сайти"]} color={0} />
      <Box x={330} y={140} w={230} h={70} title="R2 agent-sites-public" lines={["публічні сайти"]} color={0} dashed />
      <Box x={700} y={20} w={240} h={70} title="sites.домен" lines={["Cloudflare Access, перевірка JWT"]} color={2} />
      <Box x={700} y={140} w={240} h={70} title="share.домен" lines={["без Access, CSP, noindex"]} color={3} dashed />
      <Arrow points={[[220, 70], [330, 55]]} label="publish" labelAt={[275, 52]} />
      <Arrow points={[[220, 100], [270, 100], [270, 175], [330, 175]]} label="--public" labelAt={[300, 166]} dashed />
      <Arrow points={[[560, 55], [700, 55]]} />
      <Arrow points={[[560, 175], [700, 175]]} />
    </DiagramCard>
  );
}

export function Cicd() {
  return (
    <DiagramCard title="CI/CD" description="Зміни йдуть лише через PR, деплоїть GitHub Actions" viewBox="0 0 960 250" className="lg:col-span-2">
      <Box x={20} y={30} w={190} h={70} title="PR агента" lines={["гілка agent/назва"]} color={4} />
      <Box x={265} y={30} w={190} h={70} title="check" lines={["lint, tsc, vitest"]} color={0} />
      <Box x={510} y={30} w={190} h={70} title="Мерж у main" lines={["ruleset: PR і check"]} color={0} />
      <Box x={755} y={30} w={185} h={70} title="deploy" lines={["лише змінені застосунки"]} color={1} />
      <Box x={300} y={160} w={140} h={70} title="notes" lines={["production"]} color={2} />
      <Box x={460} y={160} w={140} h={70} title="sites" lines={["production"]} color={2} />
      <Box x={620} y={160} w={140} h={70} title="docs" lines={["production"]} color={2} />
      <Box x={780} y={160} w={160} h={70} title="agent" lines={["потрібне схвалення"]} color={4} dashed />
      <Arrow points={[[210, 65], [265, 65]]} />
      <Arrow points={[[455, 65], [510, 65]]} />
      <Arrow points={[[700, 65], [755, 65]]} />
      <Arrow points={[[847, 100], [847, 130], [370, 130], [370, 160]]} />
      <Arrow points={[[847, 130], [530, 130], [530, 160]]} />
      <Arrow points={[[847, 130], [690, 130], [690, 160]]} />
      <Arrow points={[[847, 130], [860, 130], [860, 160]]} />
    </DiagramCard>
  );
}

export function SessionLifecycle() {
  return (
    <DiagramCard title="Агент: життєвий цикл сесії" description="Від прийнятого завдання до видалення; диск переживає сон знімками" viewBox="0 0 960 340" className="lg:col-span-2">
      <Box x={20} y={30} w={190} h={80} title="Завдання" lines={["Telegram, Shortcut, API", "id сесії = ключ"]} color={4} />
      <Box x={265} y={30} w={190} h={80} title="Черга" lines={["запис job:<id>", "alarm будить Jobs"]} color={0} />
      <Box x={510} y={30} w={190} h={80} title="Підготовка теки" lines={["session-prep: clone", "worktree agent/назва"]} color={1} />
      <Box x={755} y={30} w={185} h={80} title="Робота" lines={["сесія OpenCode", "Watcher стежить"]} color={1} />
      <Box x={755} y={200} w={185} h={80} title="Підсумок" lines={["пост ✅ Готово", "кнопки: мерж, видалити"]} color={4} />
      <Box x={510} y={200} w={190} h={80} title="Сон і знімок" lines={["20 хв без роботи", "диск знімається"]} color={2} />
      <Box x={265} y={200} w={190} h={80} title="Відновлення" lines={["контейнер зі знімка", "сесії й worktree на місці"]} color={2} />
      <Box x={20} y={200} w={190} h={80} title="Видалення" lines={["сесія, worktree, пост", "гілка, якщо не втрачено"]} color={3} dashed />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} />
      <Arrow points={[[700, 70], [755, 70]]} />
      <Arrow points={[[847, 110], [847, 200]]} />
      <Arrow points={[[755, 240], [700, 240]]} label="простій" labelAt={[728, 232]} dashed />
      <Arrow points={[[510, 240], [455, 240]]} label="завдання" labelAt={[483, 232]} dashed />
      <Arrow points={[[360, 200], [360, 110]]} label="у чергу" labelAt={[392, 160]} />
      <Arrow points={[[847, 280], [847, 315], [115, 315], [115, 280]]} label="/delete, мерж і деплой" labelAt={[480, 307]} dashed />
    </DiagramCard>
  );
}

export function JobsWatcher() {
  return (
    <DiagramCard title="Агент: черга завдань і Watcher" description="Вебхук лише приймає завдання, виконує alarm; стежать потік подій і опитування" viewBox="0 0 960 420" className="lg:col-span-2">
      <Box x={20} y={30} w={190} h={80} title="Вхідний обробник" lines={["interface/telegram, http", "лише кладе завдання"]} color={0} />
      <Box x={265} y={30} w={190} h={80} title="application/jobs" lines={["Jobs: job:<id>", "до 6 спроб, пауза 15 с"]} color={0} />
      <Box x={510} y={30} w={190} h={80} title="alarm AgentSession" lines={["запуск у фоні", "start, followUp, watch"]} color={1} />
      <Box x={755} y={30} w={185} h={80} title="OpenCode" lines={["працює над завданням", "події інструментів"]} color={1} />
      <Box x={755} y={200} w={185} h={80} title="Потік подій (SSE)" lines={["підсумок у чат одразу", "set-repo, handoff, MCP"]} color={1} />
      <Box x={510} y={200} w={190} h={80} title="application/watch" lines={["tick кожні 15 с: страховка", "контейнер, сесія зникла"]} color={0} />
      <Box x={265} y={200} w={190} h={80} title="Ліміти витрат" lines={["AGENT_MAX_COST_USD", "AGENT_MAX_TOKENS → abort"]} color={3} />
      <Box x={510} y={330} w={190} h={70} title="Пост і чат" lines={["✅ Готово, ⛔, ⏹, ❗"]} color={4} />
      <Box x={265} y={330} w={190} h={70} title="Limits" lines={["ліміти Claude: 5 хв"]} color={2} dashed />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} />
      <Arrow points={[[700, 70], [755, 70]]} />
      <Arrow points={[[847, 110], [847, 200]]} label="події" labelAt={[875, 160]} />
      <Arrow points={[[755, 240], [700, 240]]} />
      <Arrow points={[[510, 240], [455, 240]]} label="перевищено" labelAt={[483, 232]} />
      <Arrow points={[[605, 280], [605, 330]]} label="підсумок" labelAt={[640, 310]} />
      <Arrow points={[[510, 365], [455, 365]]} label="помилка лімітів" labelAt={[483, 357]} dashed />
    </DiagramCard>
  );
}

export function McpFlow() {
  return (
    <DiagramCard title="MCP: як сервіс потрапляє в сесію" description="Роутер вирішує на старті, а команда request-mcp просить додати сервіс посеред роботи" viewBox="0 0 960 340" className="lg:col-span-2">
      <Box x={20} y={30} w={190} h={80} title="Завдання" lines={["вільна фраза власника"]} color={4} />
      <Box x={265} y={30} w={190} h={80} title="application/task" lines={["route: прапорці сервісів", "і список «можливо»"]} color={0} />
      <Box x={510} y={30} w={190} h={80} title="McpAccess" lines={["токен, конфіг теки", "оновлення в OpenCode"]} color={1} />
      <Box x={755} y={30} w={185} h={80} title="Сесія OpenCode" lines={["інструменти MCP", "Sure, Сільпо, Calendar…"]} color={1} />
      <Box x={755} y={200} w={185} h={80} title="request-mcp" lines={["команда агента в bash", "посеред роботи"]} color={1} />
      <Box x={510} y={200} w={190} h={80} title="Watcher" lines={["бачить виклик у потоці", "requestedMcp"]} color={0} />
      <Box x={265} y={200} w={190} h={80} title="application/mcp" lines={["Mcp.request без дублів", "Notices.askMcp"]} color={0} />
      <Box x={20} y={200} w={190} h={80} title="Власник у Telegram" lines={["кнопки: підключити", "чи ні"]} color={4} />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} label="сервіси" labelAt={[483, 62]} />
      <Arrow points={[[700, 70], [755, 70]]} />
      <Arrow points={[[360, 110], [360, 200]]} label="сумнів" labelAt={[388, 160]} dashed />
      <Arrow points={[[755, 240], [700, 240]]} />
      <Arrow points={[[510, 240], [455, 240]]} />
      <Arrow points={[[265, 240], [210, 240]]} label="питання" labelAt={[238, 232]} />
      <Arrow points={[[115, 280], [115, 315], [605, 315], [605, 110]]} label="так: підключення і повідомлення агентові" labelAt={[360, 307]} dashed />
    </DiagramCard>
  );
}

export function HandoffFlow() {
  return (
    <DiagramCard title="Агент: handoff між сесіями" description="Агент передає окрему роботу в нову сесію; результат назад не повертається" viewBox="0 0 960 330">
      <Box x={20} y={30} w={190} h={80} title="Агент" lines={["handoff --repo --name", "завдання в heredoc"]} color={1} />
      <Box x={265} y={30} w={190} h={80} title="payload/handoff.sh" lines={["перевіряє, що текст", "на stdin не порожній"]} color={2} />
      <Box x={510} y={30} w={190} h={80} title="application/watch" lines={["бачить bash у потоці", "id: <батьківська>-h<хеш>"]} color={0} />
      <Box x={755} y={30} w={185} h={80} title="HandoffSpawner" lines={["тема й пост у чаті", "↪️ Передано з іншої"]} color={1} />
      <Box x={755} y={200} w={185} h={80} title="Нова сесія" lines={["Jobs.begin → черга", "свій worktree й гілка"]} color={1} />
      <Box x={510} y={200} w={190} h={80} title="Нова тема" lines={["задача в цитаті", "назва з тексту задачі"]} color={4} />
      <Box x={20} y={200} w={190} h={80} title="Батьківська сесія" lines={["триває далі", "контекст лише в тексті"]} color={2} dashed />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} />
      <Arrow points={[[700, 70], [755, 70]]} />
      <Arrow points={[[847, 110], [847, 200]]} />
      <Arrow points={[[755, 240], [700, 240]]} label="пост" labelAt={[728, 232]} />
      <Arrow points={[[115, 110], [115, 200]]} dashed />
    </DiagramCard>
  );
}

export function PostsForms() {
  return (
    <DiagramCard title="Агент: пости й питання в чаті" description="Один пост на сесію оновлюється на місці; питання агента йдуть кнопками" viewBox="0 0 960 340" className="lg:col-span-2">
      <Box x={20} y={30} w={190} h={80} title="Події OpenCode" lines={["tool.input.started,", "tool.called"]} color={1} />
      <Box x={265} y={30} w={190} h={80} title="Progress" lines={["підпис дії від gpt-6-luna", "збій: технічний підпис"]} color={0} />
      <Box x={510} y={30} w={190} h={80} title="Posts" lines={["шапка, кнопки, деплой", "оновлення раз на 4 с"]} color={0} />
      <Box x={755} y={30} w={185} h={80} title="infrastructure/chat" lines={["HTML Telegram, таблиці", "клавіатури, callback"]} color={2} />
      <Box x={755} y={200} w={185} h={80} title="Власник" lines={["кнопка або текст"]} color={4} />
      <Box x={510} y={200} w={190} h={80} title="interface/telegram" lines={["callback_data", "текст → Forms.cancel"]} color={0} />
      <Box x={265} y={200} w={190} h={80} title="Forms" lines={["форма у сховищі DO", "відповідь → агентові"]} color={0} />
      <Box x={20} y={200} w={190} h={80} title="Інструмент question" lines={["питання агента", "з варіантами"]} color={1} />
      <Arrow points={[[210, 70], [265, 70]]} />
      <Arrow points={[[455, 70], [510, 70]]} />
      <Arrow points={[[700, 70], [755, 70]]} />
      <Arrow points={[[847, 110], [847, 200]]} label="пост" labelAt={[875, 160]} />
      <Arrow points={[[755, 240], [700, 240]]} />
      <Arrow points={[[510, 240], [455, 240]]} label="відповідь" labelAt={[483, 232]} />
      <Arrow points={[[210, 240], [265, 240]]} />
      <Arrow points={[[360, 200], [360, 155], [605, 155], [605, 110]]} label="показати питання" labelAt={[482, 147]} dashed />
    </DiagramCard>
  );
}

export function PortsAdapters() {
  return (
    <DiagramCard title="Агент: порти й адаптери" description="Application бачить лише порти domain/agent; адаптери в infrastructure, а тести підміняють їх фейками" viewBox="0 0 960 440" className="lg:col-span-2">
      <Box x={20} y={30} w={230} h={80} title="application/jobs" lines={["Jobs, Limits", "політика повторів"]} color={0} />
      <Box x={20} y={130} w={230} h={80} title="application/watch" lines={["Watcher", "розбір set-repo, handoff"]} color={0} />
      <Box x={20} y={230} w={230} h={80} title="application/progress" lines={["Progress, Forms, Posts", "чисті activity, title"]} color={0} />
      <Box x={20} y={330} w={230} h={80} title="application/mcp" lines={["Mcp", "розбір request-mcp"]} color={0} />
      <Box x={365} y={30} w={230} h={80} title="SessionStore, Scheduler" lines={["Notices, LimitProbe"]} color={1} />
      <Box x={365} y={130} w={230} h={80} title="OpencodeClient" lines={["Container, PullRequests"]} color={1} />
      <Box x={365} y={230} w={230} h={80} title="PostBoard, PostChat" lines={["PostStore"]} color={1} />
      <Box x={365} y={330} w={230} h={80} title="McpAccess" lines={["HandoffSpawner", "Notices.askMcp"]} color={1} />
      <Box x={710} y={30} w={230} h={80} title="state, adapters.ts" lines={["сховище DO, alarm", "ліміти Claude, чат"]} color={2} />
      <Box x={710} y={130} w={230} h={80} title="opencode, computer" lines={["HTTP-клієнт OpenCode", "контейнер, GitHub"]} color={2} />
      <Box x={710} y={230} w={230} h={80} title="progress, chat" lines={["пости Telegram", "PostRecords на сховищі"]} color={2} />
      <Box x={710} y={330} w={230} h={80} title="mcp, jobs" lines={["McpServers: токени", "Handoffs: тема й пост"]} color={2} />
      {[70, 170, 270, 370].map((y) => (
        <g key={y}>
          <Arrow points={[[250, y], [365, y]]} label="викликає" labelAt={[307, y - 8]} />
          <Arrow points={[[710, y], [595, y]]} label="реалізує" labelAt={[652, y - 8]} dashed />
        </g>
      ))}
    </DiagramCard>
  );
}

export function GithubFlow() {
  return (
    <DiagramCard title="Агент: GitHub і чат" description="Вебхуки GitHub повертають збій CI, схвалення, деплой і мерж у сесію" viewBox="0 0 960 380" className="lg:col-span-2">
      <Box x={20} y={150} w={190} h={80} title="GitHub" lines={["workflow_job, _run", "POST /github"]} color={3} />
      <Box x={265} y={150} w={190} h={80} title="interface/github" lines={["підпис X-Hub-Signature", "знаходить сесію за PR"]} color={0} />
      <Box x={560} y={30} w={380} h={80} title="Збій CI" lines={["❌ у тему сесії, агентові завдання «виправ»", "бейбісітинг: до 3 спроб на гілку, далі 🛑"]} color={3} />
      <Box x={560} y={150} w={380} h={80} title="Схвалення деплою" lines={["🚀 пост із кнопками ✅ ❌", "pending_deployments через GITHUB_APPROVE_TOKEN"]} color={4} />
      <Box x={560} y={270} w={380} h={80} title="Деплой успішний" lines={["✅ у пості, іконка теми 🎉", "прибирання сесії, worktree й гілки"]} color={2} />
      <Box x={20} y={290} w={235} h={70} title="🔀 Змерджити" lines={["PUT /pulls/N/merge", "відмова: причини в чаті"]} color={4} />
      <Arrow points={[[210, 190], [265, 190]]} />
      <Arrow points={[[455, 190], [500, 190], [500, 70], [560, 70]]} />
      <Arrow points={[[455, 190], [560, 190]]} />
      <Arrow points={[[455, 190], [500, 190], [500, 310], [560, 310]]} />
      <Arrow points={[[115, 290], [115, 230]]} label="мерж" labelAt={[145, 262]} />
    </DiagramCard>
  );
}
