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

export async function triage(
	env: Env,
	transcript: string,
	tasks: string[],
	snap: ThingsSnapshot,
	recordedAt: Date,
	timeZone: string,
): Promise<TriageItem[] | null> {
	const lists = [...snap.projects, ...snap.areas];
	const itemSchema: Record<string, unknown> = {
		type: "object",
		properties: {
			quote: { type: "string" }, // спершу цитата: пріоритет і дати модель виводить лише з неї
			title: { type: "string" },
			duplicate_of: { type: "string" },
			// enum гарантує, що модель не вигадає неіснуючий проєкт чи тег
			list: { type: "string", enum: ["", ...lists] },
			tags: allowedTags.length
				? { type: "array", items: { type: "string", enum: allowedTags } }
				: { type: "array", items: { type: "string" } },
			when: { type: "string" },
			deadline: { type: "string" },
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

	const date = new Intl.DateTimeFormat("uk-UA", {
		timeZone,
		weekday: "long",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(recordedAt);
	const isoDate = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(recordedAt);
	const block = (tag: string, items: string[]) => `<${tag}>\n${items.join("\n")}\n</${tag}>`;
	const user = [
		`Recording date: ${isoDate} (${date})`,
		`<rules>\n${rulesText || "(no rules)"}\n</rules>`,
		block("allowed_tags", allowedTags),
		block("lists", lists),
		block("existing_todos", snap.todos),
		block("tasks", tasks),
		`<transcript>\n${transcript}\n</transcript>`,
	].join("\n\n");

	const todoByKey = new Map(snap.todos.map((t) => [normalize(t), t]));
	const listSet = new Set(lists);
	const tagSet = new Set(allowedTags);
	const dateRe = /^\d{4}-\d{2}-\d{2}$/;
	const whenSet = new Set(["today", "tomorrow", "evening", "anytime", "someday"]);

	return askJson(env, { name: "things_triage", system: TRIAGE_SYSTEM, user, schema, reasoning: "low" }, (text) => {
		const raw = parseJsonObject(text).items;
		if (!Array.isArray(raw)) throw new Error("no items");
		// Перевіряємо все, що повернула модель: Gemma може не дотримуватись enum.
		return raw
			.map((r: Record<string, unknown>): TriageItem => {
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
			})
			.filter((i) => i.title);
	});
}

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------- Things URL ----------
export function buildThingsUrl(items: TriageItem[], notes: string): string {
	const todos = items.map((i) => ({
		type: "to-do",
		attributes: {
			title: i.title,
			notes,
			...(i.list && { list: i.list }),
			...(i.tags.length && { tags: i.tags }),
			...(i.when && { when: i.when }),
			...(i.deadline && { deadline: i.deadline }),
		},
	}));
	return `things:///json?reveal=true&data=${encodeURIComponent(JSON.stringify(todos))}`;
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

// ---------- Посилання «Додати в Things» ----------
// Telegram-кнопки підтримують лише http(s), тож кнопка веде на сторінку воркера,
// яка відкриває things:///json. Посилання одноразове: повторне відкриття питає підтвердження.
type ThingsLink = { url: string; count: number; usedAt?: string };

export async function createThingsLink(env: Env, url: string, count: number): Promise<string> {
	const id = crypto.randomUUID();
	await env.BUCKET.put(`things/${id}.json`, JSON.stringify({ url, count } satisfies ThingsLink));
	return id;
}

export async function handleThingsLink(env: Env, id: string, force: boolean): Promise<Response> {
	const key = `things/${id}.json`;
	const link = await (await env.BUCKET.get(key))?.json<ThingsLink>();
	if (!link) return page("Посилання застаріло", "<p>Посилання вже недійсне (зберігається 7 днів).</p>", 404);

	if (link.usedAt && !force) {
		return page(
			"Вже додано",
			`<p>Ці задачі вже відкривались у Things ${escapeHtml(link.usedAt)}.</p>` +
				`<p><a class="btn" href="?force=1">Додати ще раз</a></p>`,
		);
	}

	link.usedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
	await env.BUCKET.put(key, JSON.stringify(link));
	const href = escapeHtml(link.url);
	return page(
		"Додаю в Things…",
		`<p>Задач: ${link.count}. Якщо Things не відкрився автоматично:</p>` +
			`<p><a class="btn" href="${href}">Відкрити Things</a></p>`,
		200,
		`<meta http-equiv="refresh" content="0;url=${href}">`,
	);
}

function page(title: string, body: string, status = 200, head = ""): Response {
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
