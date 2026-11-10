import type { Env } from "./index";
import { askJson, parseJsonObject } from "./llm";

// ---------- Типи ----------
// Що є в Todoist зараз: воркер читає це з API перед тріажем.
export type TodoistSnapshot = {
	projects: { id: string; name: string; inbox: boolean; description?: string }[]; // опис — пояснення для тріажу
	labels: string[];
	tasks: string[]; // назви відкритих задач — для пошуку дублікатів
	rules: string; // опис службового проєкту RULES_PROJECT: мітки, пріоритети, загальні правила
};

// Службовий проєкт з правилами тріажу в описі. Може бути активним або в архіві; у тріажі не бере участі.
export const RULES_PROJECT = "⚙️ Правила";

// Задача з нотатки після тріажу.
export type TriageItem = {
	title: string;
	duplicateOf: string; // назва існуючої відкритої задачі або ""
	project: string; // назва проєкту або "" (Inbox)
	labels: string[];
	priority: number; // як у додатку: 1 (p1, найвищий) … 4 (p4, без пріоритету)
	due: string; // YYYY-MM-DD | YYYY-MM-DDTHH:MM (з часом) | ""
	deadline: string; // YYYY-MM-DD | "" (у Todoist дедлайн — лише дата)
	recurrence?: string; // повтор для Todoist англійською ("every monday at 9:00") | "" ; due — перше виконання
	recurrenceLabel?: string; // той самий повтор українською для підпису ("щопонеділка о 9:00")
	details?: string; // подробиці з запису, що не влізли в назву: ідуть в опис задачі в Todoist; немає в старих нотатках
	reminders?: string[]; // "before:<хв>" (до часу виконання) | YYYY-MM-DDTHH:MM; немає в нотатках до появи нагадувань
	key?: string; // стабільний ключ задачі в нотатці (t1, t2…): за ним редагування знаходить задачу в Todoist
};

// ---------- Todoist API ----------
const SYNC_URL = "https://api.todoist.com/api/v1/sync";

async function get(env: Env, path: string): Promise<Record<string, unknown>> {
	const res = await fetch(`https://api.todoist.com/api/v1/${path}`, { headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` } });
	if (!res.ok) throw new Error(`Todoist ${path} ${res.status}: ${await res.text()}`);
	return res.json();
}

export async function sync(env: Env, body: Record<string, string>): Promise<Record<string, unknown>> {
	const res = await fetch(SYNC_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` },
		body: new URLSearchParams(body),
	});
	if (!res.ok) throw new Error(`Todoist sync ${res.status}: ${await res.text()}`);
	return res.json();
}

export async function fetchSnapshot(env: Env): Promise<TodoistSnapshot> {
	const d = (await sync(env, { sync_token: "*", resource_types: JSON.stringify(["projects", "labels", "items"]) })) as {
		projects: { id: string; name: string; description?: string; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean }[];
		labels: { name: string; is_deleted?: boolean }[];
		items: { content: string; checked?: boolean; is_deleted?: boolean }[];
	};
	const active = d.projects.filter((p) => !p.is_archived && !p.is_deleted);
	return {
		projects: active
			.filter((p) => p.name !== RULES_PROJECT)
			.map((p) => ({ id: p.id, name: p.name, inbox: !!p.inbox_project, ...(p.description?.trim() && { description: p.description.trim() }) })),
		labels: d.labels.filter((l) => !l.is_deleted).map((l) => l.name),
		tasks: d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.content),
		rules: ((await findRulesProject(env, active))?.description ?? "").trim(),
	};
}

// RULES_PROJECT серед активних проєктів або в архіві (архівних проєктів немає в /sync).
export async function findRulesProject(
	env: Env,
	active: { id: string; name: string; description?: string }[],
): Promise<{ id: string; description: string } | null> {
	const own = active.find((p) => p.name === RULES_PROJECT);
	if (own) return { id: own.id, description: own.description ?? "" };
	let cursor = "";
	do {
		const page = (await get(env, `projects/archived?limit=200${cursor && `&cursor=${encodeURIComponent(cursor)}`}`)) as {
			results?: { id: string; name: string; description?: string }[];
			next_cursor?: string | null;
		};
		const found = page.results?.find((p) => p.name === RULES_PROJECT);
		if (found) return { id: found.id, description: found.description ?? "" };
		const next = page.next_cursor ?? "";
		cursor = next !== cursor ? next : ""; // захист від зациклення
	} while (cursor);
	console.error(`Todoist project "${RULES_PROJECT}" not found: triage runs without rules`);
	return null;
}

const listNames = (snap: TodoistSnapshot) => snap.projects.filter((p) => !p.inbox).map((p) => p.name);

// Поля задачі Todoist у JSON-схемі: enum гарантує, що модель не вигадає неіснуючий проєкт чи мітку.
export function taskFieldsSchema(snap: TodoistSnapshot): Record<string, unknown> {
	return {
		project: { type: "string", enum: ["", ...listNames(snap)] },
		labels: snap.labels.length
			? { type: "array", items: { type: "string", enum: snap.labels } }
			: { type: "array", items: { type: "string" } },
		priority: { type: "string", enum: ["p1", "p2", "p3", "p4"] },
		due: { type: "string" },
		deadline: { type: "string" },
		recurrence: { type: "string" },
		recurrence_label: { type: "string" },
		reminders: { type: "array", items: { type: "string" } },
		details: { type: "string" },
	};
}

// Правила автора, мітки й проєкти — і для тріажу, і для редагування задач.
// Що означає кожен проєкт, автор пише в описі проєкту в Todoist: «Назва — опис».
export function taskRulesBlock(snap: TodoistSnapshot): string {
	const projects = snap.projects
		.filter((p) => !p.inbox)
		.map((p) => (p.description ? `${p.name} — ${p.description.replace(/\s*\n\s*/g, " ")}` : p.name));
	return [
		`<rules>\n${snap.rules || "(no rules)"}\n</rules>`,
		`<labels>\n${snap.labels.join("\n")}\n</labels>`,
		`<projects>\n${projects.join("\n")}\n</projects>`,
	].join("\n\n");
}

const TASK_FIELDS_HELP = `- project: a project from <projects> (name before " — "; the rest is what the project is for) that clearly fits the task, or "" (Inbox) if none clearly fits. Never guess.
- labels: labels from <labels> that clearly apply, or [] if none.
- priority: "p1" (highest) … "p4" (no priority), following the rules.
- due: when the task should be done, only if said: "today", "tomorrow" or YYYY-MM-DD, plus " HH:MM" if a time is said ("до 13:00", "о 19:00" → "today 13:00", "today 19:00"); otherwise "".
- deadline: a date YYYY-MM-DD only if a separate final deadline is mentioned that is later than due (e.g. "почати завтра, здати до п'ятниці"); never repeat the due date as a deadline; otherwise "".
- recurrence: only if the author says the task repeats ("щодня", "щопонеділка", "кожні два тижні", "раз на місяць", "щороку 1 березня"): a Todoist recurring date in English that starts with "every", with the time if said: "every day", "every weekday", "every monday at 9:00", "every 2 weeks", "every month on the 5th", "every year on march 1"; otherwise "". When set, due is the first occurrence (with the time, if said).
  Regular intake or procedures over several days ("двічі на день протягом 5 днів", "тричі на день тиждень", "щоранку до 20 листопада") are recurring too.
  Limited period ("протягом 7 днів", "тиждень", "до 20 листопада"): add " until YYYY-MM-DD" with the last day, counting the first day as day 1 ("протягом 7 днів" from 2026-11-10 → "every day until 2026-11-16"); for a range ("2–3 дні") take the longer one.
  Several times a day ("двічі на день", "тричі на день"): Todoist cannot repeat a task several times a day, so use "every day" (with "until" if limited) and keep the per-day frequency in the title.
- recurrence_label: the same repetition in short Ukrainian for display ("щопонеділка о 9:00", "кожні 2 тижні", "щодня до 16.11"), or "" when there is no recurrence.
- reminders: only if the author explicitly asks to be reminded ("нагадай…"): "before N" = N minutes before the due time (only when due has a time, e.g. "нагадай за годину" → "before 60"), or an absolute "today HH:MM" / "tomorrow HH:MM" / "YYYY-MM-DD HH:MM" ("нагадай завтра о 9" → "tomorrow 09:00"); otherwise [].
- details: a description of the task in Ukrainian with the specifics the author said that don't fit in the title: what exactly, how, why, names, amounts, addresses, links, list items, conditions. Use the author's facts only, never invent or pad, no timing (it is in due/recurrence). One to a few short sentences or "• " lines; "" if the title already says everything.
- Task titles never contain dates, timing words or durations ("завтра", "19 листопада", "протягом 7 днів", "щодня"): timing goes only to due/deadline/recurrence. What to do and how much stays in the title, including dosage and per-day frequency ("Приймати Нольпазу 40 мг — 1 таблетку зранку за 30 хвилин до їжі", "Промивати ніс Носолем тричі на день").`;

// Дата у форматі YYYY-MM-DD у часовому поясі.
export function isoDate(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date);
}

// Дата для промпту: "2026-11-09 (понеділок, 09.11.2026)".
export function promptDate(date: Date, timeZone: string): string {
	const long = new Intl.DateTimeFormat("uk-UA", { timeZone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	return `${isoDate(date, timeZone)} (${long})`;
}

// Перевіряє поля задачі, які повернула модель (Gemma може не дотримуватись enum).
// "today"/"tomorrow" перетворюються на дату відносно base (дата запису або правки).
export function taskValidator(snap: TodoistSnapshot, base: Date, timeZone: string): (r: Record<string, unknown>) => TriageItem {
	const taskByKey = new Map(snap.tasks.map((t) => [normalize(t), t]));
	const projects = new Set(listNames(snap));
	const labels = new Set(snap.labels);
	const dateRe = /^\d{4}-\d{2}-\d{2}$/;
	// Календарні дні від дати base у timeZone (не +24 год: так перехід на літній час не зсуває дату).
	const [y, m, d] = isoDate(base, timeZone).split("-").map(Number);
	const day = (offset: number) => new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
	const date = (v: unknown) => {
		const s = String(v ?? "").trim();
		return s === "today" ? day(0) : s === "tomorrow" ? day(1) : dateRe.test(s) ? s : "";
	};
	// Дата з необов'язковим часом: "today 13:00", "2026-11-10T13:00", "2026-11-10 9:05" → "2026-11-10T13:00".
	const dateTime = (v: unknown) => {
		const [, dayPart, hh, mm] = String(v ?? "").trim().match(/^(\S+?)(?:[ T@](\d{1,2}):(\d{2})(?::\d{2})?)?$/) ?? [];
		const ymd = date(dayPart);
		if (!ymd || hh === undefined) return ymd;
		return Number(hh) < 24 && Number(mm) < 60 ? `${ymd}T${hh.padStart(2, "0")}:${mm}` : ymd;
	};
	// Нагадування: "before 60" → "before:60" (лише коли в дати виконання є час), дата з часом → YYYY-MM-DDTHH:MM.
	const reminders = (v: unknown, dueHasTime: boolean): string[] => {
		const out = (Array.isArray(v) ? v : []).map((x) => {
			const rel = String(x).trim().match(/^before[ :]?(\d{1,4})$/);
			if (rel) return dueHasTime && Number(rel[1]) > 0 ? `before:${Number(rel[1])}` : "";
			const at = dateTime(x);
			return at.includes("T") ? at : ""; // нагадування без часу Todoist не підтримує
		});
		return [...new Set(out.filter(Boolean))];
	};
	// Повтор: лише фраза Todoist, що починається з "every"; без неї й підпис порожній.
	const recurrence = (r: Record<string, unknown>) => {
		const every = String(r.recurrence ?? "").trim().toLowerCase().replace(/\s+/g, " ");
		if (!/^every\b/.test(every)) return { recurrence: "", recurrenceLabel: "" };
		return { recurrence: every, recurrenceLabel: String(r.recurrence_label ?? "").trim() || every };
	};
	return (r) => {
		const project = projects.has(String(r.project ?? "").trim()) ? String(r.project).trim() : "";
		const priority = Number(String(r.priority ?? "").replace(/^p/, ""));
		return {
			title: String(r.title ?? "").trim(),
			duplicateOf: taskByKey.get(normalize(String(r.duplicate_of ?? ""))) ?? "",
			project,
			// Лише існуючі мітки, без повторів і без мітки, що збігається з назвою проєкту (Home у Home).
			labels: Array.isArray(r.labels)
				? [...new Set(r.labels.map(String))].filter((l) => labels.has(l) && normalize(l) !== normalize(project))
				: [],
			priority: priority >= 1 && priority <= 4 ? priority : 4,
			due: dateTime(r.due),
			...recurrence(r),
			reminders: reminders(r.reminders, dateTime(r.due).includes("T")),
			details: String(r.details ?? "").trim(),
			// Дедлайн, що збігається з датою виконання, лише дублює її.
			deadline: ((dl) => (dl && dl !== dateTime(r.due).slice(0, 10) ? dl : ""))(date(String(r.deadline ?? "").trim().split(/[ T@]/)[0])),
		};
	};
}

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- Тріаж ----------
const TRIAGE_SYSTEM = `You triage tasks from a Ukrainian voice note into the author's Todoist.
For each task in <tasks>, return exactly one item, in the same order:
- quote: the exact fragment of the transcript where this specific task is mentioned (one sentence or clause, copied verbatim).
- title: a concise to-do title in Ukrainian that starts with a verb. Keep the given wording unless it can be made clearer.
- duplicate_of: if an existing open task in <existing_tasks> means the same thing, copy its title exactly as written there; otherwise "". Only mark real duplicates, not merely related tasks.
${TASK_FIELDS_HELP}
Resolve relative dates ("в п'ятницю", "через тиждень") from the recording date.
Decide priority, due and deadline ONLY from the words inside that task's quote. If the quote itself has no words about urgency, importance or timing, the task gets p4, no due and no deadline, even if a neighbouring task is urgent. A deadline alone is not a reason for a higher priority.
If the author says they are waiting for someone or something related to a task, that task is waiting (see the rules for the matching label).
Follow the author's rules in <rules>.`;

export async function triage(
	env: Env,
	transcript: string,
	tasks: string[],
	snap: TodoistSnapshot,
	recordedAt: Date,
	timeZone: string,
): Promise<TriageItem[] | null> {
	const itemSchema = {
		type: "object",
		properties: {
			quote: { type: "string" }, // спершу цитата: пріоритет і дати модель виводить лише з неї
			title: { type: "string" },
			duplicate_of: { type: "string" },
			...taskFieldsSchema(snap),
		},
		required: ["quote", "title", "duplicate_of", "project", "labels", "priority", "due", "deadline", "recurrence", "recurrence_label", "reminders", "details"],
		additionalProperties: false,
	};
	const schema = {
		type: "object",
		properties: { items: { type: "array", items: itemSchema } },
		required: ["items"],
		additionalProperties: false,
	};
	const user = [
		`Recording date: ${promptDate(recordedAt, timeZone)}`,
		taskRulesBlock(snap),
		`<existing_tasks>\n${snap.tasks.join("\n")}\n</existing_tasks>`,
		`<tasks>\n${tasks.join("\n")}\n</tasks>`,
		`<transcript>\n${transcript}\n</transcript>`,
	].join("\n\n");
	const validate = taskValidator(snap, recordedAt, timeZone);

	return askJson(env, { name: "todoist_triage", system: TRIAGE_SYSTEM, user, schema, reasoning: "low" }, (text) => {
		const raw = parseJsonObject(text).items;
		if (!Array.isArray(raw)) throw new Error("no items");
		return raw
			.map((r: Record<string, unknown>, i: number) => ({ ...validate(r), key: `t${i + 1}` }))
			.filter((i) => i.title);
	});
}

// Опис полів задач для моделі редагування.
export const EDIT_TASKS_HELP = `If tasks have Todoist fields (project, labels, priority, due, deadline, recurrence, recurrence_label, reminders, details), copy them unchanged unless the instruction changes them. Field meanings:
${TASK_FIELDS_HELP}
Follow the author's <rules>.`;

// ---------- Операції в Todoist ----------
// Що з нотатки вже є в Todoist (за ключем задачі).
export type InTodoist = Record<string, { id: string; item: TriageItem; reminderIds?: string[] }>;
// Без id — створити; з id і item — оновити (move: змінився проєкт; reminders: перестворити нагадування,
// oldReminderIds — що видалити; describe: змінились подробиці, переписати опис); з id без item — видалити.
export type TodoistOp = {
	key: string;
	item: TriageItem | null;
	id?: string;
	move?: boolean;
	reminders?: boolean;
	oldReminderIds?: string[];
	describe?: boolean;
};

const inTodoistKey = (noteId: string) => `notes/${noteId}.todoist.json`;

export async function getInTodoist(env: Env, noteId: string): Promise<InTodoist> {
	return (await (await env.BUCKET.get(inTodoistKey(noteId)))?.json<InTodoist>()) ?? {};
}

const sameItem = (a: TriageItem, b: TriageItem) =>
	a.title === b.title &&
	a.project === b.project &&
	[...a.labels].sort().join() === [...b.labels].sort().join() &&
	a.priority === b.priority &&
	a.due === b.due &&
	a.deadline === b.deadline &&
	(a.recurrence ?? "") === (b.recurrence ?? "") &&
	(a.details ?? "") === (b.details ?? "") &&
	sameReminders(a, b);
const sameReminders = (a: TriageItem, b: TriageItem) => [...(a.reminders ?? [])].sort().join() === [...(b.reminders ?? [])].sort().join();

// Що зробити в Todoist: змінені задачі оновити, нові створити, прибрані видалити.
// Дублікати існуючих задач не створюємо; незмінені задачі пропускаємо.
export function planOps(items: TriageItem[], inTodoist: InTodoist): TodoistOp[] {
	const ops: TodoistOp[] = [];
	const kept = new Set<string>();
	for (const item of items) {
		const prev = item.key ? inTodoist[item.key] : undefined;
		if (prev) {
			kept.add(item.key!);
			if (!sameItem(prev.item, item)) {
				ops.push({
					key: item.key!,
					item,
					id: prev.id,
					...(prev.item.project !== item.project && { move: true }),
					...(!sameReminders(prev.item, item) && { reminders: true, oldReminderIds: prev.reminderIds ?? [] }),
					...((prev.item.details ?? "") !== (item.details ?? "") && { describe: true }),
				});
			}
		} else if (!item.duplicateOf) {
			ops.push({ key: item.key ?? "", item });
		}
	}
	for (const [key, prev] of Object.entries(inTodoist)) {
		if (!kept.has(key)) ops.push({ key, item: null, id: prev.id });
	}
	return ops;
}

// Команди /sync для операцій. uuid сталий для дії й операції: повторне натискання
// чи ретрай не виконає команду вдруге (Todoist ігнорує повторний uuid).
export function buildCommands(actionId: string, ops: TodoistOp[], description: string, snap: TodoistSnapshot): object[] {
	// Опис задачі: подробиці з запису, під ними — посилання на нотатку.
	const describe = (i: TriageItem) => (i.details ? `${i.details}\n\n${description}` : description);
	const projectId = (name: string) => snap.projects.find((p) => (name ? p.name === name : p.inbox))?.id;
	const fields = (i: TriageItem) => ({
		content: i.title,
		labels: i.labels,
		priority: 5 - i.priority, // в API 4 — це p1
		// Повтор — фразою (Todoist сам рахує дати); інакше дата, з часом — «плаваючий» час (без поясу).
		due: i.recurrence
			? { string: i.recurrence, lang: "en" }
			: i.due
				? { date: i.due.includes("T") ? `${i.due}:00` : i.due }
				: null,
		deadline: i.deadline ? { date: i.deadline } : null,
	});
	return ops.flatMap((op, n) => {
		const uuid = (suffix = "") => `${actionId}-${n}${suffix}`;
		// Нагадування задачі (item_id може бути temp_id щойно створеної задачі в цьому ж пакеті).
		const addReminders = (itemId: string, item: TriageItem) =>
			(item.reminders ?? []).map((r, j) => ({
				type: "reminder_add",
				uuid: uuid(`r${j}`),
				temp_id: `tmp-${actionId}-${n}r${j}`,
				args: r.startsWith("before:")
					? { item_id: itemId, type: "relative", minute_offset: Number(r.slice(7)) }
					: { item_id: itemId, type: "absolute", due: { date: `${r}:00` } },
			}));
		if (!op.id) {
			const { due, deadline, ...rest } = fields(op.item!);
			const project_id = op.item!.project ? projectId(op.item!.project) : undefined;
			const temp_id = `tmp-${actionId}-${n}`;
			return [
				{
					type: "item_add",
					uuid: uuid(),
					temp_id,
					args: { ...rest, description: describe(op.item!), ...(project_id && { project_id }), ...(due && { due }), ...(deadline && { deadline }) },
				},
				...addReminders(temp_id, op.item!),
			];
		}
		if (!op.item) return [{ type: "item_delete", uuid: uuid(), args: { id: op.id } }];
		// Опис переписуємо лише коли змінились подробиці: інакше не чіпаємо те, що автор дописав у Todoist сам.
		const cmds: object[] = [
			{ type: "item_update", uuid: uuid(), args: { id: op.id, ...fields(op.item), ...(op.describe && { description: describe(op.item) }) } },
		];
		// Проєкт могли перейменувати чи видалити після тріажу: тоді задачу не переміщуємо.
		const target = op.move ? projectId(op.item.project) : undefined;
		if (target) cmds.push({ type: "item_move", uuid: uuid("m"), args: { id: op.id, project_id: target } });
		if (op.reminders) {
			(op.oldReminderIds ?? []).forEach((id, k) => cmds.push({ type: "reminder_delete", uuid: uuid(`rd${k}`), args: { id } }));
			cmds.push(...addReminders(op.id, op.item));
		}
		return cmds;
	});
}

// ---------- Дія за кнопкою «Додати / Оновити в Todoist» ----------
// Зберігається в R2 до натискання (`todoist/<id>.json`); кнопка в Telegram — callback_data "td:<id>".
type Action = { ops: TodoistOp[]; description: string; noteId: string; messageUrl?: string; appliedAt?: string };
const actionKey = (id: string) => `todoist/${id}.json`;

export async function createAction(env: Env, ops: TodoistOp[], description: string, noteId: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.BUCKET.put(actionKey(id), JSON.stringify({ ops, description, noteId } satisfies Action));
	return id;
}

export async function setActionMessage(env: Env, id: string, messageUrl: string): Promise<void> {
	const action = await (await env.BUCKET.get(actionKey(id)))?.json<Action>();
	if (!action) return;
	action.messageUrl = messageUrl;
	await env.BUCKET.put(actionKey(id), JSON.stringify(action));
}

export async function deleteAction(env: Env, id: string): Promise<void> {
	await env.BUCKET.delete(actionKey(id));
}

// Виконує дію в Todoist і оновлює стан InTodoist нотатки.
export async function applyAction(
	env: Env,
	id: string,
): Promise<{ status: "applied"; noteId: string; count: number } | { status: "already" } | { status: "missing" }> {
	const action = await (await env.BUCKET.get(actionKey(id)))?.json<Action>();
	if (!action) return { status: "missing" };
	if (action.appliedAt) return { status: "already" };

	const snap = await fetchSnapshot(env);
	const description = action.messageUrl ? `${action.description}\n${action.messageUrl}` : action.description;
	type SyncResult = { sync_status: Record<string, unknown>; temp_id_mapping: Record<string, string> };
	const run = async (commands: object[]) => (await sync(env, { commands: JSON.stringify(commands) })) as SyncResult;
	const res = await run(buildCommands(id, action.ops, description, snap));

	// Повтор, якого Todoist не розпізнав (INVALID_DATE), відхиляє всю команду: такі задачі пробуємо ще раз без повтору
	// (з датою першого виконання). В InTodoist вони потрапляють без повтору, тож підпис не покаже 🔁.
	const prefix = action.ops.map(() => id);
	const ops = [...action.ops];
	const bad = action.ops.flatMap((op, n) => (op.item?.recurrence && invalidDate(res.sync_status[`${id}-${n}`]) ? [n] : []));
	if (bad.length) {
		const retryId = `${id}x`;
		bad.forEach((n) => {
			ops[n] = { ...ops[n], item: { ...ops[n].item!, recurrence: "", recurrenceLabel: "" } };
			prefix[n] = retryId;
			// Статуси задачі й залежних команд (нагадування, переміщення): їх замінять статуси повтору.
			const own = new RegExp(`^${id}-${n}(?:[a-z]|$)`);
			for (const k of Object.keys(res.sync_status)) if (own.test(k)) delete res.sync_status[k];
			console.error(`todoist: recurrence "${action.ops[n].item!.recurrence}" not recognized, task "${action.ops[n].item!.title}" saved without it`);
		});
		const mine = (c: object) => bad.some((n) => new RegExp(`^${retryId}-${n}(?:[a-z]|$)`).test((c as { uuid: string }).uuid));
		const retry = await run(buildCommands(retryId, ops, description, snap).filter(mine));
		Object.assign(res.sync_status, retry.sync_status);
		Object.assign(res.temp_id_mapping, retry.temp_id_mapping);
	}
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");

	// Стан оновлюємо і для успішних команд при частковому збої: інакше ID створених задач загубляться.
	// Повтор безпечний: Todoist не виконує команду з тим самим uuid вдруге.
	const state = await getInTodoist(env, action.noteId);
	ops.forEach((op, n) => {
		const p = prefix[n];
		if (res.sync_status[`${p}-${n}`] !== "ok") return;
		if (!op.item) delete state[op.key];
		else {
			const taskId = op.id ?? res.temp_id_mapping[`tmp-${p}-${n}`];
			// ID нагадувань: нові — з temp_id_mapping, інакше лишаються попередні.
			const reminderIds =
				!op.id || op.reminders
					? (op.item.reminders ?? []).map((_, j) => res.temp_id_mapping[`tmp-${p}-${n}r${j}`]).filter(Boolean)
					: state[op.key]?.reminderIds;
			if (taskId) state[op.key] = { id: taskId, item: op.item, ...(reminderIds?.length && { reminderIds }) };
		}
	});
	await env.BUCKET.put(inTodoistKey(action.noteId), JSON.stringify(state));
	if (errors.length) throw new Error(`Todoist commands failed: ${JSON.stringify(errors)}`);
	action.appliedAt = new Date().toISOString();
	await env.BUCKET.put(actionKey(id), JSON.stringify(action));
	return { status: "applied", noteId: action.noteId, count: action.ops.length };
}

const invalidDate = (status: unknown) => (status as { error_tag?: string } | undefined)?.error_tag === "INVALID_DATE";

// Підпис показує повтор лише тих задач, які в Todoist справді з повтором.
export function withAppliedRecurrence(items: TriageItem[] | null, inTodoist: InTodoist): TriageItem[] | null {
	return (
		items?.map((i) => {
			const applied = i.key ? inTodoist[i.key] : undefined;
			return i.recurrence && applied && !applied.item.recurrence ? { ...i, recurrence: "", recurrenceLabel: "" } : i;
		}) ?? null
	);
}

// Видаляє задачі, які ще відкриті (виконані лишаються в історії Todoist). Повертає кількість видалених.
export async function deleteOpenTasks(env: Env, ids: string[]): Promise<number> {
	if (!ids.length) return 0;
	const d = (await sync(env, { sync_token: "*", resource_types: JSON.stringify(["items"]) })) as {
		items: { id: string; checked?: boolean; is_deleted?: boolean }[];
	};
	const open = new Set(d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.id));
	const commands = ids.filter((id) => open.has(id)).map((id) => ({ type: "item_delete", uuid: `delete-${id}`, args: { id } }));
	if (!commands.length) return 0;
	const res = (await sync(env, { commands: JSON.stringify(commands) })) as { sync_status: Record<string, unknown> };
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");
	if (errors.length) throw new Error(`Todoist delete failed: ${JSON.stringify(errors)}`);
	return commands.length;
}

// ---------- Підпис ----------
// Посилання на задачу в Todoist (веб і застосунки).
export const taskUrl = (id: string) => `https://app.todoist.com/app/task/${id}`;

// Рядки задач для підпису в Telegram. Задачі, що вже в Todoist, стають посиланнями (note.ts → taskLinks).
export function formatTriage(items: TriageItem[]): string {
	return items
		.map((i) => {
			if (i.duplicateOf) return `• ↩️ вже є: ${i.duplicateOf}`;
			const extra = [
				`→ ${i.project || "Inbox"}`,
				i.priority < 4 && `p${i.priority}`,
				...i.labels.map((l) => `@${l}`),
				i.due && `📅 ${i.due.replace("T", " ")}`,
				i.recurrence && `🔁 ${i.recurrenceLabel || i.recurrence}`,
				i.deadline && `⏰ ${i.deadline}`,
				...(i.reminders ?? []).map((r) => (r.startsWith("before:") ? `🔔 −${r.slice(7)} хв` : `🔔 ${r.replace("T", " ")}`)),
			].filter(Boolean);
			return `• ${i.title} ${extra.join(" ")}`;
		})
		.join("\n");
}
