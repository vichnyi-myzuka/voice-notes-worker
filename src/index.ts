import { askJson, parseJsonObject } from "./llm";
import {
	buildThingsUrl,
	createThingsLink,
	formatTriage,
	handleThingsLink,
	snapshotFromForm,
	triage,
	type ThingsSnapshot,
	type TriageItem,
} from "./things";

export interface Env {
	AI: Ai;
	BUCKET: R2Bucket;
	QUEUE: Queue<Job>;
	// secrets
	SECRET: string;
	OPENAI_KEY?: string; // для gpt-6-luna; без нього одразу Gemma
	BOT_TOKEN: string;
	CHAT_ID: string;
	// vars
	TIMEZONE: string;
	PUBLIC_URL: string; // адреса воркера для кнопки «Додати в Things»
}

type Job = { key: string };

// Проміжний стан обробки, зберігається в R2 поруч з аудіо (`<key>.state.json`).
// Дає ідемпотентність: повторна спроба не платить ще раз за Whisper/LLM
// і не шле в Telegram те, що вже відправлено.
type State = {
	transcript?: string;
	meta?: Meta;
	triage?: TriageItem[] | null; // null: тріаж не вдався або не потрібен
	thingsLinkId?: string;
	audioSent?: boolean;
};

const DLQ_NAME = "voice-notes-dlq";
const MAX_RETRIES = 4; // той самий, що max_retries у wrangler.toml
// Whisper у Workers AI працює ~9x швидше за реальний час, а consumer має 15 хв wall time.
// 25 MB це ~50 хв аудіо iPhone (~64 kbps) або ~100 хв при 32 kbps, тобто з запасом.
const TRANSCRIBE_MAX_BYTES = 25_000_000;
const TELEGRAM_MAX_BYTES = 50_000_000; // ліміт Bot API на upload: 50 MB
const CAPTION_MAX = 1024;

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);

		// Сторінка кнопки «Додати в Things» (без секрету: id випадковий і одноразовий).
		const link = url.pathname.match(/^\/things\/([0-9a-f-]{36})$/);
		if (link && req.method === "GET") return handleThingsLink(env, link[1], url.searchParams.has("force"));

		// ---------- Producer ----------
		if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
		if (!env.SECRET) return new Response("SECRET is not configured", { status: 500 });
		if (!(await safeEqual(req.headers.get("x-secret") ?? "", env.SECRET))) {
			return new Response("unauthorized", { status: 401 });
		}

		// Два формати: сирий файл у тілі або форма (audio + знімок Things).
		// Тіло читаємо повністю (не стрімом): R2 put потребує відомої довжини.
		let body: ArrayBuffer;
		let snapshot: ThingsSnapshot | null = null;
		if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
			const form = await req.formData();
			const audio = form.get("audio");
			if (!audio || typeof audio === "string") return new Response("missing audio field", { status: 400 });
			body = await audio.arrayBuffer();
			snapshot = snapshotFromForm(form);
		} else {
			body = await req.arrayBuffer();
		}
		if (body.byteLength === 0) return new Response("empty body", { status: 400 });

		const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.m4a`;
		await env.BUCKET.put(key, body, { httpMetadata: { contentType: "audio/mp4" } });
		if (snapshot) await env.BUCKET.put(`${key}.things.json`, JSON.stringify(snapshot));
		await env.QUEUE.send({ key });
		return new Response("ok");
	},

	// ---------- Consumers ----------
	async queue(batch, env): Promise<void> {
		if (batch.queue === DLQ_NAME) {
			for (const msg of batch.messages) {
				await tgSendMessage(
					env,
					`⚠️ Не вдалося обробити голосовий запис після ${MAX_RETRIES + 1} спроб.\n` +
						`Ключ: ${msg.body.key}\nФайл лишається в R2 (бакет voice-notes) до 7 днів.`,
				);
				msg.ack();
			}
			return;
		}

		for (const msg of batch.messages) {
			try {
				await processNote(env, msg.body.key, msg.attempts > MAX_RETRIES);
				msg.ack();
			} catch (err) {
				console.error(`attempt ${msg.attempts} failed for ${msg.body.key}:`, err);
				throw err; // -> retry, після max_retries -> DLQ
			}
		}
	},
} satisfies ExportedHandler<Env, Job>;

async function processNote(env: Env, key: string, lastAttempt: boolean): Promise<void> {
	const obj = await env.BUCKET.get(key);
	if (!obj) {
		// Аудіо видаляється лише після успішної відправки, тож це повторна доставка.
		console.log(`${key} not found, already processed`);
		return;
	}

	const stateKey = `${key}.state.json`;
	const thingsKey = `${key}.things.json`;
	const state: State = (await (await env.BUCKET.get(stateKey))?.json<State>()) ?? {};
	const save = () => env.BUCKET.put(stateKey, JSON.stringify(state));
	const recordedAt = formatRecordedAt(key, env.TIMEZONE);

	// Задовгий для транскрипції в межах 15 хв: не ретраїмо, шлемо оригінал без транскрипту.
	if (obj.size > TRANSCRIBE_MAX_BYTES) {
		if (!state.audioSent) {
			const mb = (obj.size / 1_000_000).toFixed(1);
			if (obj.size > TELEGRAM_MAX_BYTES) {
				await tgSendMessage(
					env,
					`🎙 Запис ${recordedAt} (${mb} МБ) завеликий і для транскрипції (ліміт 25 МБ), і для Telegram-бота (50 МБ).\n` +
						`Ключ: ${key}. Файл лишається в R2 до 7 днів.`,
				);
			} else {
				const audio = new Blob([await obj.arrayBuffer()], { type: "audio/mp4" });
				await tgSendAudio(
					env,
					audio,
					`Запис ${recordedAt}`,
					`Запис ${recordedAt}\n\nФайл ${mb} МБ більший за ліміт транскрипції (25 МБ), тому без транскрипту й summary.`,
				);
			}
			state.audioSent = true;
			await save();
		}
		await env.BUCKET.delete([key, stateKey, thingsKey]);
		return;
	}

	const audio = new Blob([await obj.arrayBuffer()], { type: "audio/mp4" });

	if (state.transcript === undefined) {
		state.transcript = await transcribe(env, audio);
		await save();
	}
	if (state.meta === undefined) {
		state.meta = await summarize(env, state.transcript, recordedAt, lastAttempt);
		await save();
	}
	const meta = state.meta;

	// Тріаж задач для Things: лише якщо шорткат надіслав знімок і в нотатці є задачі.
	// Невдалий тріаж не блокує нотатку: вона прийде без кнопки.
	if (state.triage === undefined) {
		const snap = meta.tasks.length ? await (await env.BUCKET.get(thingsKey))?.json<ThingsSnapshot>() : null;
		state.triage = snap
			? await triage(env, state.transcript, meta.tasks, snap, new Date(recordedTs(key)), env.TIMEZONE)
			: null;
		await save();
	}
	const newTasks = state.triage?.filter((i) => !i.duplicateOf) ?? [];
	if (newTasks.length && !state.thingsLinkId) {
		const url = buildThingsUrl(newTasks, `🎙 ${meta.title} (${recordedAt})`);
		state.thingsLinkId = await createThingsLink(env, url, newTasks.length);
		console.log(`things link ${state.thingsLinkId}: ${newTasks.length} new, ${state.triage!.length - newTasks.length} duplicates`);
		await save();
	}

	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	if (!state.audioSent) {
		const button = state.thingsLinkId && {
			inline_keyboard: [
				[{ text: `➕ Додати в Things (${newTasks.length})`, url: `${env.PUBLIC_URL}/things/${state.thingsLinkId}` }],
			],
		};
		const caption = truncate(formatCaption(meta, state.triage ?? null), CAPTION_MAX);
		await tgSendAudio(env, audio, meta.title, caption, button || undefined);
		state.audioSent = true;
		await save();
	}

	await env.BUCKET.delete([key, stateKey, thingsKey]);
}

// ---------- Workers AI: whisper-large-v3-turbo ----------
async function transcribe(env: Env, audio: Blob): Promise<string> {
	// Аудіо передаємо потоком (без base64). Автор завжди говорить українською,
	// тож задаємо мову явно, щоб модель не сплутала її, наприклад, з російською.
	const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
		audio: { body: audio.stream(), contentType: "audio/mp4" },
		language: "uk",
	});
	return (res.text ?? "").trim();
}

// ---------- Title + summary: gpt-6-luna, при збої — Gemma 4 ----------
const SYSTEM_PROMPT = `You write a title, a summary, key ideas and tasks for a voice note transcript.
The author always speaks Ukrainian.
Rules:
- Always write everything in Ukrainian, even if the transcript contains words or phrases in other languages or was transcribed imperfectly.
- Keep names, brands and technical terms as they are commonly written.
- title: at most 6 words, no quotes, no trailing period.
- summary: 2-4 sentences.
- ideas: the main thoughts, decisions or insights voiced in the note, up to 5 items, each under 12 words. Do not repeat the summary word for word.
- tasks: concrete action items, todos, reminders and wishes for later ("колись хочу прочитати…") mentioned in the note, up to 10 items, each under 12 words and starting with a verb; include deadlines or people if mentioned. Keep separate actions as separate items.
- Do not create vague "start" tasks ("почати роботу над…", "зайнятися…", "працювати над проєктом…") when the note also names a concrete action for the same thing. Merge them into one concrete task and keep the timing from the vague one. Example: "19 листопада треба почати новий проєкт, там треба розгорнути інстанс на Cloudflare" → one task: "Розгорнути інстанс на Cloudflare для нового проєкту" (the 19 November timing belongs to it).
- If there are no ideas or no tasks, return an empty array for that field. Do not invent anything that is not in the transcript.`;

// Structured output: модель повертає JSON саме такої форми.
const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		summary: { type: "string" },
		ideas: { type: "array", items: { type: "string" } },
		tasks: { type: "array", items: { type: "string" } },
	},
	required: ["title", "summary", "ideas", "tasks"],
	additionalProperties: false,
};

type Meta = { title: string; summary: string; ideas: string[]; tasks: string[] };

async function summarize(env: Env, transcript: string, recordedAt: string, lastAttempt: boolean): Promise<Meta> {
	if (!transcript) return { title: recordedAt, summary: "(порожній транскрипт)", ideas: [], tasks: [] };

	const meta = await askJson(
		env,
		{ name: "voice_note", system: SYSTEM_PROMPT, user: `<transcript>\n${transcript}\n</transcript>`, schema: SUMMARY_SCHEMA },
		parseMeta,
	);
	if (meta) return meta;

	// Обидві моделі не впорались: ретраїмо, а на останній спробі — fallback замість DLQ.
	if (!lastAttempt) throw new Error("All summary models failed");
	return {
		title: recordedAt,
		summary: transcript.length > 300 ? `${transcript.slice(0, 300)}…` : transcript,
		ideas: [],
		tasks: [],
	};
}

function parseMeta(text: string): Meta {
	const json = parseJsonObject(text);
	const title = String(json.title ?? "").trim();
	const summary = String(json.summary ?? "").trim();
	if (!title || !summary) throw new Error("empty title/summary");
	const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
	return { title, summary, ideas: list(json.ideas), tasks: list(json.tasks) };
}

// Підпис до аудіо: назва, summary і (якщо є) списки думок і задач.
// Якщо був тріаж, задачі показуються з проєктом, тегами, датами й позначкою дублікатів.
function formatCaption({ title, summary, ideas, tasks }: Meta, triaged: TriageItem[] | null): string {
	const parts = [title, summary];
	if (ideas.length) parts.push(`💡 Ключові думки:\n${ideas.map((i) => `• ${i}`).join("\n")}`);
	if (triaged?.length) parts.push(`✅ Задачі:\n${formatTriage(triaged)}`);
	else if (tasks.length) parts.push(`✅ Задачі:\n${tasks.map((t) => `• ${t}`).join("\n")}`);
	return parts.join("\n\n");
}

// ---------- Telegram ----------
async function tgSendAudio(
	env: Env,
	audio: Blob,
	title: string,
	caption: string,
	replyMarkup?: object,
): Promise<void> {
	const form = new FormData();
	form.append("chat_id", env.CHAT_ID);
	form.append("audio", audio, `${safeFileName(title)}.m4a`);
	form.append("title", title);
	form.append("caption", caption);
	if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
	await tg(env, "sendAudio", form);
}

async function tgSendMessage(env: Env, text: string): Promise<void> {
	await tg(env, "sendMessage", JSON.stringify({ chat_id: env.CHAT_ID, text }));
}

async function tg(env: Env, method: string, body: FormData | string): Promise<void> {
	const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
		method: "POST",
		headers: typeof body === "string" ? { "content-type": "application/json" } : undefined,
		body,
	});
	if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
}

// ---------- helpers ----------
async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

function recordedTs(key: string): number {
	return Number(key.split("-")[0]);
}

function formatRecordedAt(key: string, timeZone: string): string {
	// sv-SE дає формат "2026-11-09 14:30"
	return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(
		new Date(recordedTs(key)),
	);
}

function safeFileName(name: string): string {
	const clean = name
		.replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
	return clean || "voice-note";
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
