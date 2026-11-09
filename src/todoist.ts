import type { Env } from "./index";
import { askJson, parseJsonObject } from "./llm";
import RULES from "./todoist-rules.txt";

// ---------- Типи ----------
// Що є в Todoist зараз: воркер читає це з API перед тріажем.
export type TodoistSnapshot = {
	projects: { id: string; name: string; inbox: boolean }[];
	labels: string[];
	tasks: string[]; // назви відкритих задач — для пошуку дублікатів
};

// Задача з нотатки після тріажу.
export type TriageItem = {
	title: string;
	duplicateOf: string; // назва існуючої відкритої задачі або ""
	project: string; // назва проєкту або "" (Inbox)
	labels: string[];
	priority: number; // як у додатку: 1 (p1, найвищий) … 4 (p4, без пріоритету)
	due: string; // YYYY-MM-DD | ""
	deadline: string; // YYYY-MM-DD | ""
	key?: string; // стабільний ключ задачі в нотатці (t1, t2…): за ним редагування знаходить задачу в Todoist
};

// ---------- Todoist API ----------
const SYNC_URL = "https://api.todoist.com/api/v1/sync";

async function sync(env: Env, body: Record<string, string>): Promise<Record<string, unknown>> {
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
		projects: { id: string; name: string; inbox_project?: boolean; is_archived?: boolean; is_deleted?: boolean }[];
		labels: { name: string; is_deleted?: boolean }[];
		items: { content: string; checked?: boolean; is_deleted?: boolean }[];
	};
	return {
		projects: d.projects
			.filter((p) => !p.is_archived && !p.is_deleted)
			.map((p) => ({ id: p.id, name: p.name, inbox: !!p.inbox_project })),
		labels: d.labels.filter((l) => !l.is_deleted).map((l) => l.name),
		tasks: d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.content),
	};
}

// ---------- Правила з todoist-rules.txt ----------
// Рядки з # — коментарі. Секція [мітки]: «Мітка — опис».
const rulesText = RULES.split(/\r?\n/)
	.filter((l) => !l.trim().startsWith("#"))
	.join("\n")
	.trim();

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
	};
}

// Правила автора, мітки й проєкти — і для тріажу, і для редагування задач.
export function taskRulesBlock(snap: TodoistSnapshot): string {
	return [
		`<rules>\n${rulesText || "(no rules)"}\n</rules>`,
		`<labels>\n${snap.labels.join("\n")}\n</labels>`,
		`<projects>\n${listNames(snap).join("\n")}\n</projects>`,
	].join("\n\n");
}

const TASK_FIELDS_HELP = `- project: a project from <projects> that clearly fits the task, or "" (Inbox) if none clearly fits. Never guess.
- labels: labels from <labels> that clearly apply, or [] if none.
- priority: "p1" (highest) … "p4" (no priority), following the rules.
- due: "today", "tomorrow" or a date YYYY-MM-DD when the task should be done, only if said; otherwise "".
- deadline: a date YYYY-MM-DD only if a deadline is mentioned; otherwise "".
- Task titles never contain dates or timing words ("завтра", "19 листопада"): timing goes only to due/deadline.`;

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
			due: date(r.due),
			deadline: date(r.deadline),
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
		required: ["quote", "title", "duplicate_of", "project", "labels", "priority", "due", "deadline"],
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
export const EDIT_TASKS_HELP = `If tasks have Todoist fields (project, labels, priority, due, deadline), copy them unchanged unless the instruction changes them. Field meanings:
${TASK_FIELDS_HELP}
Follow the author's <rules>.`;

// ---------- Операції в Todoist ----------
// Що з нотатки вже є в Todoist (за ключем задачі).
export type InTodoist = Record<string, { id: string; item: TriageItem }>;
// Без id — створити; з id і item — оновити (move: змінився проєкт); з id без item — видалити.
export type TodoistOp = { key: string; item: TriageItem | null; id?: string; move?: boolean };

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
	a.deadline === b.deadline;

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
				ops.push({ key: item.key!, item, id: prev.id, ...(prev.item.project !== item.project && { move: true }) });
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
	const projectId = (name: string) => snap.projects.find((p) => (name ? p.name === name : p.inbox))?.id;
	const fields = (i: TriageItem) => ({
		content: i.title,
		labels: i.labels,
		priority: 5 - i.priority, // в API 4 — це p1
		due: i.due ? { date: i.due } : null,
		deadline: i.deadline ? { date: i.deadline } : null,
	});
	return ops.flatMap((op, n) => {
		const uuid = (suffix = "") => `${actionId}-${n}${suffix}`;
		if (!op.id) {
			const { due, deadline, ...rest } = fields(op.item!);
			const project_id = op.item!.project ? projectId(op.item!.project) : undefined;
			return [
				{
					type: "item_add",
					uuid: uuid(),
					temp_id: `tmp-${actionId}-${n}`,
					args: { ...rest, description, ...(project_id && { project_id }), ...(due && { due }), ...(deadline && { deadline }) },
				},
			];
		}
		if (!op.item) return [{ type: "item_delete", uuid: uuid(), args: { id: op.id } }];
		const cmds: object[] = [{ type: "item_update", uuid: uuid(), args: { id: op.id, ...fields(op.item) } }];
		// Проєкт могли перейменувати чи видалити після тріажу: тоді задачу не переміщуємо.
		const target = op.move ? projectId(op.item.project) : undefined;
		if (target) cmds.push({ type: "item_move", uuid: uuid("m"), args: { id: op.id, project_id: target } });
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
	const commands = buildCommands(id, action.ops, description, snap);
	const res = (await sync(env, { commands: JSON.stringify(commands) })) as {
		sync_status: Record<string, unknown>;
		temp_id_mapping: Record<string, string>;
	};
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");

	// Стан оновлюємо і для успішних команд при частковому збої: інакше ID створених задач загубляться.
	// Повтор безпечний: Todoist не виконує команду з тим самим uuid вдруге.
	const state = await getInTodoist(env, action.noteId);
	action.ops.forEach((op, n) => {
		if (res.sync_status[`${id}-${n}`] !== "ok") return;
		if (!op.item) delete state[op.key];
		else {
			const taskId = op.id ?? res.temp_id_mapping[`tmp-${id}-${n}`];
			if (taskId) state[op.key] = { id: taskId, item: op.item };
		}
	});
	await env.BUCKET.put(inTodoistKey(action.noteId), JSON.stringify(state));
	if (errors.length) throw new Error(`Todoist commands failed: ${JSON.stringify(errors)}`);
	action.appliedAt = new Date().toISOString();
	await env.BUCKET.put(actionKey(id), JSON.stringify(action));
	return { status: "applied", noteId: action.noteId, count: action.ops.length };
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
				i.due && `📅 ${i.due}`,
				i.deadline && `⏰ ${i.deadline}`,
			].filter(Boolean);
			return `• ${i.title} ${extra.join(" ")}`;
		})
		.join("\n");
}
