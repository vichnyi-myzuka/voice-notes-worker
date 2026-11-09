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
}

type Job = { key: string };

// Проміжний стан обробки, зберігається в R2 поруч з аудіо (`<key>.state.json`).
// Дає ідемпотентність: повторна спроба не платить ще раз за Whisper/LLM
// і не шле в Telegram те, що вже відправлено.
type State = {
	transcript?: string;
	meta?: Meta;
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
	// ---------- Producer ----------
	async fetch(req, env): Promise<Response> {
		if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
		if (!env.SECRET) return new Response("SECRET is not configured", { status: 500 });
		if (!(await safeEqual(req.headers.get("x-secret") ?? "", env.SECRET))) {
			return new Response("unauthorized", { status: 401 });
		}

		// arrayBuffer(), а не стрім: R2 put потребує відомої довжини тіла.
		const body = await req.arrayBuffer();
		if (body.byteLength === 0) return new Response("empty body", { status: 400 });

		const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.m4a`;
		await env.BUCKET.put(key, body, { httpMetadata: { contentType: "audio/mp4" } });
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
		await env.BUCKET.delete([key, stateKey]);
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

	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	if (!state.audioSent) {
		await tgSendAudio(env, audio, meta.title, truncate(formatCaption(meta), CAPTION_MAX));
		state.audioSent = true;
		await save();
	}

	await env.BUCKET.delete([key, stateKey]);
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
- tasks: concrete action items, todos and reminders mentioned in the note, up to 7 items, each under 12 words and starting with a verb; include deadlines or people if mentioned.
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

	// Основна модель — Luna; якщо вона недоступна або відповіла не тим, пробуємо Gemma.
	const models: [string, (env: Env, transcript: string) => Promise<string>][] = [
		["gpt-6-luna", askLuna],
		["gemma-4", askGemma],
	];
	for (const [name, ask] of models) {
		let text = "";
		try {
			text = await ask(env, transcript);
			const meta = parseMeta(text);
			console.log(`summary by ${name}: ${meta.title}`);
			return meta;
		} catch (err) {
			console.error(`${name} failed:`, err, text);
		}
	}

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
	const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
	const title = String(json.title ?? "").trim();
	const summary = String(json.summary ?? "").trim();
	if (!title || !summary) throw new Error("empty title/summary");
	const list = (v: unknown) =>
		Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
	return { title, summary, ideas: list(json.ideas), tasks: list(json.tasks) };
}

// Підпис до аудіо: назва, summary і (якщо є) списки думок і задач.
function formatCaption({ title, summary, ideas, tasks }: Meta): string {
	const parts = [title, summary];
	if (ideas.length) parts.push(`💡 Ключові думки:\n${ideas.map((i) => `• ${i}`).join("\n")}`);
	if (tasks.length) parts.push(`✅ Задачі:\n${tasks.map((t) => `• ${t}`).join("\n")}`);
	return parts.join("\n\n");
}

async function askLuna(env: Env, transcript: string): Promise<string> {
	if (!env.OPENAI_KEY) throw new Error("OPENAI_KEY is not set");
	const res = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { Authorization: `Bearer ${env.OPENAI_KEY}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: "gpt-6-luna",
			reasoning: { effort: "none" },
			max_output_tokens: 1024,
			input: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` },
			],
			text: { format: { type: "json_schema", name: "voice_note", schema: SUMMARY_SCHEMA, strict: true } },
		}),
	});
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { output: { type: string; content?: { type: string; text?: string }[] }[] };
	return data.output
		.filter((o) => o.type === "message")
		.flatMap((o) => o.content ?? [])
		.filter((c) => c.type === "output_text")
		.map((c) => c.text ?? "")
		.join("");
}

async function askGemma(env: Env, transcript: string): Promise<string> {
	const res = (await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` },
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: "voice_note", schema: SUMMARY_SCHEMA, strict: true },
		},
		chat_template_kwargs: { enable_thinking: false }, // reasoning для назви не потрібен
		max_completion_tokens: 1024,
	} as never)) as { choices?: { message?: { content?: unknown } }[]; response?: unknown };
	// Структуровану відповідь модель може віддати як рядок або вже як об'єкт.
	const content = res.choices?.[0]?.message?.content ?? res.response ?? "";
	return typeof content === "string" ? content : JSON.stringify(content);
}

// ---------- Telegram ----------
async function tgSendAudio(env: Env, audio: Blob, title: string, caption: string): Promise<void> {
	const form = new FormData();
	form.append("chat_id", env.CHAT_ID);
	form.append("audio", audio, `${safeFileName(title)}.m4a`);
	form.append("title", title);
	form.append("caption", caption);
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

function formatRecordedAt(key: string, timeZone: string): string {
	const ts = Number(key.split("-")[0]);
	// sv-SE дає формат "2026-11-09 14:30"
	return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "short" }).format(
		new Date(ts),
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
