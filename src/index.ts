export interface Env {
	BUCKET: R2Bucket;
	QUEUE: Queue<Job>;
	// secrets
	SECRET: string;
	OPENAI_KEY: string;
	BOT_TOKEN: string;
	CHAT_ID: string;
	// vars
	TIMEZONE: string;
}

type Job = { key: string };

// Проміжний стан обробки, зберігається в R2 поруч з аудіо (`<key>.state.json`).
// Дає ідемпотентність: повторна спроба не платить ще раз за Whisper/gpt-6-luna
// і не шле в Telegram те, що вже відправлено.
type State = {
	transcript?: string;
	title?: string;
	summary?: string;
	audioSent?: boolean;
	textPartsSent?: number;
};

const DLQ_NAME = "voice-notes-dlq";
const MAX_RETRIES = 4; // той самий, що max_retries у wrangler.toml
const WHISPER_MAX_BYTES = 25_000_000; // ліміт OpenAI: 25 MB
const TELEGRAM_MAX_BYTES = 50_000_000; // ліміт Bot API на upload: 50 MB
const CAPTION_MAX = 1024;
const MESSAGE_MAX = 4096;

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

	// Завеликий для Whisper: не ретраїмо, шлемо оригінал без транскрипту.
	if (obj.size > WHISPER_MAX_BYTES) {
		if (!state.audioSent) {
			const mb = (obj.size / 1_000_000).toFixed(1);
			if (obj.size > TELEGRAM_MAX_BYTES) {
				await tgSendMessage(
					env,
					`🎙 Запис ${recordedAt} (${mb} МБ) завеликий і для Whisper (25 МБ), і для Telegram-бота (50 МБ).\n` +
						`Ключ: ${key}. Файл лишається в R2 до 7 днів.`,
				);
			} else {
				const audio = new Blob([await obj.arrayBuffer()], { type: "audio/mp4" });
				await tgSendAudio(
					env,
					audio,
					`Запис ${recordedAt}`,
					`Запис ${recordedAt}\n\nФайл ${mb} МБ більший за ліміт Whisper (25 МБ), тому без транскрипту й summary.`,
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
	const transcript = state.transcript;

	if (state.title === undefined || state.summary === undefined) {
		const meta = await summarize(env, transcript, recordedAt, lastAttempt);
		state.title = meta.title;
		state.summary = meta.summary;
		await save();
	}
	const { title, summary } = state;

	// Короткий транскрипт вміщаємо прямо в caption, довгий шлемо окремо.
	const base = `${title}\n\n${summary}`;
	const full = transcript ? `${base}\n\n${transcript}` : base;
	const transcriptInCaption = full.length <= CAPTION_MAX;
	const caption = transcriptInCaption ? full : truncate(base, CAPTION_MAX);

	if (!state.audioSent) {
		await tgSendAudio(env, audio, title, caption);
		state.audioSent = true;
		await save();
	}

	if (!transcriptInCaption) {
		const parts = splitText(transcript, MESSAGE_MAX);
		for (let i = state.textPartsSent ?? 0; i < parts.length; i++) {
			await tgSendMessage(env, parts[i]);
			state.textPartsSent = i + 1;
			await save();
		}
	}

	await env.BUCKET.delete([key, stateKey]);
}

// ---------- OpenAI Whisper ----------
async function transcribe(env: Env, audio: Blob): Promise<string> {
	const form = new FormData();
	form.append("file", audio, "audio.m4a");
	form.append("model", "whisper-1");
	const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { Authorization: `Bearer ${env.OPENAI_KEY}` },
		body: form,
	});
	if (!res.ok) throw new Error(`Whisper ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { text: string };
	return data.text.trim();
}

// ---------- OpenAI gpt-6-luna: title + summary ----------
const SYSTEM_PROMPT = `You write a title and a summary for a voice note transcript.
Rules:
- Write in the same language as the transcript.
- Title: at most 6 words, no quotes, no trailing period.
- Summary: 2-4 sentences.`;

// Structured output: модель гарантовано повертає JSON саме такої форми.
const SUMMARY_SCHEMA = {
	type: "object",
	properties: { title: { type: "string" }, summary: { type: "string" } },
	required: ["title", "summary"],
	additionalProperties: false,
};

async function summarize(
	env: Env,
	transcript: string,
	recordedAt: string,
	lastAttempt: boolean,
): Promise<{ title: string; summary: string }> {
	if (!transcript) return { title: recordedAt, summary: "(порожній транскрипт)" };
	const fallback = {
		title: recordedAt,
		summary: transcript.length > 300 ? `${transcript.slice(0, 300)}…` : transcript,
	};

	let text: string;
	try {
		const res = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.OPENAI_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "gpt-6-luna",
				reasoning: { effort: "none" },
				max_output_tokens: 1024,
				input: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: `<transcript>\n${transcript}\n</transcript>` },
				],
				text: {
					format: { type: "json_schema", name: "voice_note", schema: SUMMARY_SCHEMA, strict: true },
				},
			}),
		});
		if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
		const data = (await res.json()) as {
			output: { type: string; content?: { type: string; text?: string }[] }[];
		};
		text = data.output
			.filter((o) => o.type === "message")
			.flatMap((o) => o.content ?? [])
			.filter((c) => c.type === "output_text")
			.map((c) => c.text ?? "")
			.join("");
	} catch (err) {
		// Помилка API: ретраїмо, але на останній спробі краще fallback, ніж DLQ.
		if (lastAttempt) {
			console.error("Summary API failed on last attempt, using fallback:", err);
			return fallback;
		}
		throw err;
	}

	try {
		const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
		const title = String(json.title ?? "").trim();
		const summary = String(json.summary ?? "").trim();
		if (!title || !summary) throw new Error("empty title/summary");
		return { title, summary };
	} catch (err) {
		console.error("Bad JSON from model, using fallback:", err, text);
		return fallback;
	}
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

function splitText(text: string, max: number): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
		if (cut < max / 2) cut = max;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).trimStart();
	}
	if (rest) parts.push(rest);
	return parts;
}
