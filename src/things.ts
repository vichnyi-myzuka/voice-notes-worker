import type { Env } from "./index";
import { askJson, parseJsonObject } from "./llm";
import RULES from "./things-rules.txt";

// Знімок Things, який шорткат надсилає разом з аудіо (назви, по одній на рядок).
export type ThingsSnapshot = { projects: string[]; areas: string[]; todos: string[] };

// Результат тріажу однієї задачі з нотатки.
export type TriageItem = {
	title: string;
	duplicateOf: string; // назва існуючої відкритої задачі або ""
	list: string; // проєкт чи область або "" (без області)
	tags: string[];
	when: string; // today | tomorrow | evening | someday | YYYY-MM-DD | ""
	deadline: string; // YYYY-MM-DD | ""
	key?: string; // стабільний ключ задачі в нотатці (t1, t2…): за ним редагування знаходить задачу в Things
};

// ---------- Знімок ----------
export function snapshotFromForm(form: FormData): ThingsSnapshot | null {
	const lines = (field: string) => {
		const v = form.get(field);
		if (typeof v !== "string") return [];
		return [...new Set(v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
	};
	const snap = { projects: lines("projects"), areas: lines("areas"), todos: lines("todos") };
	return snap.projects.length || snap.areas.length || snap.todos.length ? snap : null;
}

// ---------- Правила з things-rules.txt ----------
// Рядки з # — коментарі. Секція [теги]: по одному тегу на рядок, опис після " — ".
const rulesText = RULES.split(/\r?\n/)
	.filter((l) => !l.trim().startsWith("#"))
	.join("\n")
	.trim();

const allowedTags: string[] = (() => {
	const tags: string[] = [];
	let inTags = false;
	for (const raw of rulesText.split("\n")) {
		const line = raw.trim();
		if (/^\[.*\]$/.test(line)) {
			inTags = line.toLowerCase() === "[теги]";
			continue;
		}
		if (!inTags || !line) continue;
		const tag = line.replace(/^[-•*]\s*/, "").split(/\s+[—–-]\s+/)[0].trim();
		if (tag) tags.push(tag);
	}
	return tags;
})();

// ---------- Тріаж ----------
const TRIAGE_SYSTEM = `You triage tasks from a Ukrainian voice note into the author's Things 3 task manager.
For each task in <tasks>, return exactly one item, in the same order:
- quote: the exact fragment of the transcript where this specific task is mentioned (one sentence or clause, copied verbatim).
- title: a concise to-do title in Ukrainian that starts with a verb. Keep the given wording unless it can be made clearer. Remove dates and timing words ("завтра", "19 листопада", "орієнтовно") from the title: timing goes only to when/deadline.
- duplicate_of: if an existing open to-do in <existing_todos> means the same thing, copy its title exactly as written there; otherwise "". Only mark real duplicates, not merely related tasks.
- list: the project or area from <lists> that clearly fits the task, or "" (Inbox) if none clearly fits. Never guess.
- tags: tags from the allowed list that clearly apply, or [] if none.
- when: "today", "tomorrow", "evening", "someday" or a date YYYY-MM-DD, only if the note says when to do it; otherwise "".
- deadline: a date YYYY-MM-DD only if the note mentions a deadline; otherwise "".
Resolve relative dates ("в п'ятницю", "через тиждень") from the recording date.
Decide priority tags, "when" and "deadline" ONLY from the words inside that task's quote. If the quote itself has no words about urgency, importance or timing, the task gets no priority tag, no "when" and no "deadline", even if a neighbouring task is urgent. A deadline alone is not a reason for a priority tag.
If the author says they are waiting for someone or something related to a task, that task is waiting (see the rules for the matching tag).
Follow the author's rules in <rules>.`;

// Поля задачі Things у JSON-схемі: enum гарантує, що модель не вигадає неіснуючий проєкт чи тег.
export function taskFieldsSchema(snap: ThingsSnapshot): Record<string, unknown> {
	return {
		list: { type: "string", enum: ["", ...snap.projects, ...snap.areas] },
		tags: allowedTags.length
			? { type: "array", items: { type: "string", enum: allowedTags } }
			: { type: "array", items: { type: "string" } },
		when: { type: "string" },
		deadline: { type: "string" },
	};
}

// Перевіряє поля задачі, які повернула модель (Gemma може не дотримуватись enum).
export function taskValidator(snap: ThingsSnapshot): (r: Record<string, unknown>) => TriageItem {
	const todoByKey = new Map(snap.todos.map((t) => [normalize(t), t]));
	const listSet = new Set([...snap.projects, ...snap.areas]);
	const tagSet = new Set(allowedTags);
	const dateRe = /^\d{4}-\d{2}-\d{2}$/;
	const whenSet = new Set(["today", "tomorrow", "evening", "anytime", "someday"]);
	return (r) => {
		const when = String(r.when ?? "").trim();
		const deadline = String(r.deadline ?? "").trim();
		const list = listSet.has(String(r.list ?? "").trim()) ? String(r.list).trim() : "";
		// Лише дозволені теги, без повторів і без тегу, що збігається з назвою області
		// (наприклад, тег Home в області Home). Смислові збіги — у things-rules.txt.
		const tags = Array.isArray(r.tags)
			? [...new Set(r.tags.map(String))].filter((t) => tagSet.has(t) && normalize(t) !== normalize(list))
			: [];
		// В Inbox — лише коли немає ні області, ні тегів. Задача без області й дати
		// потрапила б в Inbox навіть з тегами, тож для неї ставимо when=anytime.
		const validWhen = whenSet.has(when) || dateRe.test(when) ? when : "";
		return {
			title: String(r.title ?? "").trim(),
			duplicateOf: todoByKey.get(normalize(String(r.duplicate_of ?? ""))) ?? "",
			list,
			tags,
			when: !list && tags.length && !validWhen ? "anytime" : validWhen,
			deadline: dateRe.test(deadline) ? deadline : "",
		};
	};
}

// Правила автора, дозволені теги й списки — і для тріажу, і для редагування задач.
export function taskRulesBlock(snap: ThingsSnapshot): string {
	return [
		`<rules>\n${rulesText || "(no rules)"}\n</rules>`,
		`<allowed_tags>\n${allowedTags.join("\n")}\n</allowed_tags>`,
		`<lists>\n${[...snap.projects, ...snap.areas].join("\n")}\n</lists>`,
	].join("\n\n");
}

// Дата у форматі для промпту: "2026-11-09 (понеділок, 09.11.2026)".
export function promptDate(date: Date, timeZone: string): string {
	const long = new Intl.DateTimeFormat("uk-UA", { timeZone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	return `${new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date)} (${long})`;
}

export async function triage(
	env: Env,
	transcript: string,
	tasks: string[],
	snap: ThingsSnapshot,
	recordedAt: Date,
	timeZone: string,
): Promise<TriageItem[] | null> {
	const itemSchema: Record<string, unknown> = {
		type: "object",
		properties: {
			quote: { type: "string" }, // спершу цитата: пріоритет і дати модель виводить лише з неї
			title: { type: "string" },
			duplicate_of: { type: "string" },
			...taskFieldsSchema(snap),
		},
		required: ["quote", "title", "duplicate_of", "list", "tags", "when", "deadline"],
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
		`<existing_todos>\n${snap.todos.join("\n")}\n</existing_todos>`,
		`<tasks>\n${tasks.join("\n")}\n</tasks>`,
		`<transcript>\n${transcript}\n</transcript>`,
	].join("\n\n");
	const validate = taskValidator(snap);

	return askJson(env, { name: "things_triage", system: TRIAGE_SYSTEM, user, schema, reasoning: "low" }, (text) => {
		const raw = parseJsonObject(text).items;
		if (!Array.isArray(raw)) throw new Error("no items");
		return raw
			.map((r: Record<string, unknown>, i: number) => ({ ...validate(r), key: `t${i + 1}` }))
			.filter((i) => i.title);
	});
}

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- Операції в Things ----------
// Без thingsId — створити задачу; з thingsId — оновити її (attributes: лише змінені поля, або canceled).
export type ThingsOp = { key: string; item: TriageItem | null; thingsId?: string; attributes?: Record<string, unknown> };
// Що з нотатки вже є в Things (за ключем задачі): стан після останнього застосованого посилання.
export type InThings = Record<string, { thingsId: string; item: TriageItem }>;
const inThingsKey = (noteId: string) => `notes/${noteId}.things.json`;

export async function getInThings(env: Env, noteId: string): Promise<InThings> {
	return (await (await env.BUCKET.get(inThingsKey(noteId)))?.json<InThings>()) ?? {};
}

// Зміни між тим, що в Things, і новою версією задачі (для операції update).
export function changedAttributes(prev: TriageItem, next: TriageItem): Record<string, unknown> {
	const a: Record<string, unknown> = {};
	if (prev.title !== next.title) a.title = next.title;
	if (prev.list !== next.list && next.list) a.list = next.list; // в Inbox через URL scheme не перемістити
	if (prev.tags.join() !== next.tags.join()) a.tags = next.tags;
	if (prev.when !== next.when) a.when = next.when || "anytime";
	if (prev.deadline !== next.deadline) a.deadline = next.deadline; // "" прибирає дедлайн
	return a;
}

function buildThingsUrl(ops: ThingsOp[], notes: string, authToken: string, successUrl?: string): string {
	const data = ops.map((op) =>
		op.thingsId
			? { type: "to-do", operation: "update", id: op.thingsId, attributes: op.attributes ?? {} }
			: {
					type: "to-do",
					attributes: {
						title: op.item!.title,
						notes,
						...(op.item!.list && { list: op.item!.list }),
						...(op.item!.tags.length && { tags: op.item!.tags }),
						...(op.item!.when && { when: op.item!.when }),
						...(op.item!.deadline && { deadline: op.item!.deadline }),
					},
				},
	);
	const params = [`reveal=true`, `data=${encodeURIComponent(JSON.stringify(data))}`];
	if (authToken) params.push(`auth-token=${encodeURIComponent(authToken)}`);
	if (successUrl) params.push(`x-success=${encodeURIComponent(successUrl)}`);
	return `things:///json?${params.join("&")}`;
}

// Рядки задач для підпису в Telegram.
export function formatTriage(items: TriageItem[]): string {
	return items
		.map((i) => {
			if (i.duplicateOf) return `• ↩️ вже є: ${i.duplicateOf}`;
			const extra = [
				i.list ? `→ ${i.list}` : !i.tags.length && !i.when ? "→ Inbox" : "",
				...i.tags.map((t) => `#${t.replace(/\s+/g, "_")}`),
				i.when && (i.when === "anytime" ? "📋 Anytime" : `📅 ${i.when}`),
				i.deadline && `⏰ ${i.deadline}`,
			].filter(Boolean);
			return `• ${i.title}${extra.length ? ` ${extra.join(" ")}` : ""}`;
		})
		.join("\n");
}

// ---------- Посилання «Додати / Оновити в Things» ----------
// Telegram-кнопки підтримують лише http(s), тож кнопка веде на сторінку воркера,
// яка відкриває things:///json. Посилання одноразове: повторне відкриття питає підтвердження.
// things:///json збирається в момент натискання, тож посилання на повідомлення в Telegram
// (відоме лише після відправки) можна дописати пізніше через setThingsLinkMessage.
// Після виконання Things відкриває x-success (/things/<id>/done) з ID створених задач —
// так редагування потім оновлює ці задачі, а не створює нові.
type ThingsLink = {
	ops?: ThingsOp[];
	items?: TriageItem[]; // формат до появи ops (лише створення)
	notes: string;
	messageUrl?: string;
	noteId?: string;
	usedAt?: string;
	applied?: boolean; // x-success отримано, стан InThings оновлено
};
type LegacyThingsLink = { url: string; count: number; usedAt?: string }; // формат до 2026-11-09, живе до 7 днів

const linkKey = (id: string) => `things/${id}.json`;

export async function createThingsLink(env: Env, ops: ThingsOp[], notes: string, noteId?: string): Promise<string> {
	const id = crypto.randomUUID();
	await env.BUCKET.put(linkKey(id), JSON.stringify({ ops, notes, noteId } satisfies ThingsLink));
	return id;
}

// Чи відкривали вже посилання (тобто чи задачі, найімовірніше, вже в Things).
export async function thingsLinkUsed(env: Env, id: string): Promise<boolean> {
	return !!(await (await env.BUCKET.get(linkKey(id)))?.json<ThingsLink>())?.usedAt;
}

export async function setThingsLinkMessage(env: Env, id: string, messageUrl: string): Promise<void> {
	const link = await (await env.BUCKET.get(linkKey(id)))?.json<ThingsLink>();
	if (!link) return;
	link.messageUrl = messageUrl;
	await env.BUCKET.put(linkKey(id), JSON.stringify(link));
}

export async function handleThingsLink(env: Env, id: string, force: boolean): Promise<Response> {
	const link = await (await env.BUCKET.get(linkKey(id)))?.json<ThingsLink | LegacyThingsLink>();
	if (!link) return page("Посилання застаріло", "<p>Посилання вже недійсне (зберігається 7 днів).</p>", 404);

	if (link.usedAt && !force) {
		return page(
			"Вже відкривалось",
			`<p>Це посилання вже відкривалось у Things ${escapeHtml(link.usedAt)}.</p>` +
				`<p><a class="btn" href="?force=1">Відкрити ще раз</a></p>`,
		);
	}

	let url: string, count: number;
	if ("url" in link) {
		({ url, count } = link);
	} else {
		const ops: ThingsOp[] = link.ops ?? (link.items ?? []).map((item) => ({ key: "", item }));
		const updates = ops.some((op) => op.thingsId);
		if (updates && !env.THINGS_AUTH_TOKEN) {
			return page("Немає токена Things", "<p>Для оновлення задач потрібен секрет <code>THINGS_AUTH_TOKEN</code>.</p>", 500);
		}
		const notes = link.messageUrl ? `${link.notes}\n${link.messageUrl}` : link.notes;
		const done = link.noteId ? `${env.PUBLIC_URL}/things/${id}/done` : undefined;
		url = buildThingsUrl(ops, notes, updates ? env.THINGS_AUTH_TOKEN! : "", done);
		count = ops.length;
	}
	link.usedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
	await env.BUCKET.put(linkKey(id), JSON.stringify(link));
	const href = escapeHtml(url);
	return page(
		"Відкриваю Things…",
		`<p>Задач: ${count}. Якщо Things не відкрився автоматично:</p>` +
			`<p><a class="btn" href="${href}">Відкрити Things</a></p>`,
		200,
		`<meta http-equiv="refresh" content="0;url=${href}">`,
	);
}

// x-success від Things: зберігаємо ID створених задач і застосовуємо оновлення до стану InThings.
export async function handleThingsDone(env: Env, id: string, url: URL): Promise<Response> {
	const link = await (await env.BUCKET.get(linkKey(id)))?.json<ThingsLink>();
	const back = link?.messageUrl
		? `<p><a class="btn" href="${escapeHtml(link.messageUrl)}">Повернутися до нотатки</a></p>`
		: "<p>Можна закрити цю сторінку.</p>";
	if (link?.ops && link.noteId && !link.applied) {
		const raw = url.searchParams.get("x-things-ids") ?? "";
		let ids: string[] = [];
		try {
			ids = JSON.parse(raw);
		} catch {
			ids = raw.split(",").filter(Boolean);
		}
		// Things повертає ID створених задач у порядку операцій; про всяк випадок приймаємо й ID для кожної операції.
		const creates = link.ops.filter((op) => !op.thingsId);
		const idFor = new Map<ThingsOp, string>();
		if (ids.length === link.ops.length) link.ops.forEach((op, i) => idFor.set(op, ids[i]));
		else creates.forEach((op, i) => ids[i] && idFor.set(op, ids[i]));

		const state = await getInThings(env, link.noteId);
		for (const op of link.ops) {
			if (!op.item) delete state[op.key];
			else {
				const thingsId = op.thingsId ?? idFor.get(op);
				if (thingsId) state[op.key] = { thingsId, item: op.item };
			}
		}
		await env.BUCKET.put(inThingsKey(link.noteId), JSON.stringify(state));
		link.applied = true;
		await env.BUCKET.put(linkKey(id), JSON.stringify(link));
		console.log(`things link ${id} applied: ${ids.length} created ids`);
	}
	return page("✅ Готово", back);
}

export function page(title: string, body: string, status = 200, head = ""): Response {
	const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8">${head}
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;margin:3em 1.5em;text-align:center}
.btn{display:inline-block;padding:.8em 1.4em;border-radius:12px;background:#1b6ef3;color:#fff;text-decoration:none}</style>
</head><body><h2>${escapeHtml(title)}</h2>${body}</body></html>`;
	return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
