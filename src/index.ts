import { askJson, parseJsonObject } from "./llm";
import {
	createThingsLink,
	formatTriage,
	handleThingsLink,
	page,
	setThingsLinkMessage,
	snapshotFromForm,
	thingsLinkUsed,
	triage,
	type ThingsSnapshot,
	type TriageItem,
} from "./things";
import { receiveTelegramVoice, telegramMessageUrl, tg, tgSendMessage, tgSendNote } from "./telegram";

export interface Env {
	AI: Ai;
	BUCKET: R2Bucket;
	QUEUE: Queue<Job>;
	// secrets
	SECRET: string;
	OPENAI_KEY?: string; // для gpt-6-luna; без нього одразу Gemma
	BOT_TOKEN: string;
	CHAT_ID: string; // куди надсилати нотатки (канал)
	TG_WEBHOOK_SECRET?: string; // секрет вебхука для голосових з особистого чату
	TG_OWNER_ID?: string; // Telegram user id, від якого бот приймає голосові
	// vars
	TIMEZONE: string;
	PUBLIC_URL: string; // адреса воркера для кнопок «Додати в Things» і «Редагувати»
	SHORTCUT_NAME: string; // назва шорткату, який відкриває кнопка «Редагувати»
	LOCAL_DEV?: string; // ставиться лише в `npm run dev`
}

// edit: id нотатки, яку редагує цей запис (замість створення нової).
type Job = { key: string; edit?: string };

// Проміжний стан обробки, зберігається в R2 поруч з аудіо (`<key>.state.json`).
// Дає ідемпотентність: повторна спроба не платить ще раз за Whisper/LLM
// і не шле в Telegram те, що вже відправлено.
type State = {
	transcript?: string;
	meta?: Meta;
	triage?: TriageItem[] | null; // null: тріаж не вдався або не потрібен
	thingsLinkId?: string;
	audioSent?: boolean;
	messageId?: number; // id повідомлення з аудіо в Telegram
	messageLinked?: boolean; // посилання на повідомлення дописане в дані кнопки
	originalDeleted?: boolean; // оригінальне голосове з каналу видалене
	noteId?: string; // id для кнопки «Редагувати», створюється до відправки
	captionEdited?: boolean; // (редагування) підпис нотатки вже оновлено
};

// Опублікована нотатка, зберігається для редагування (`notes/<id>.json`, 7 днів за lifecycle бакета).
// `notes/msg-<message_id>` вказує на id нотатки: так відповідь у каналі знаходить, що редагувати.
type Note = {
	transcript: string;
	edits: string[]; // інструкції попередніх редагувань
	meta: Meta;
	triage: TriageItem[] | null;
	thingsLinkId?: string;
	messageId: number;
	recordedTs: number;
};
const noteKey = (id: string) => `notes/${id}.json`;
const noteByMessageKey = (messageId: number | string) => `notes/msg-${messageId}`;

const DLQ_NAME = "voice-notes-dlq";
const MAX_RETRIES = 4; // той самий, що max_retries у wrangler.toml
// Whisper у Workers AI працює ~9x швидше за реальний час, а consumer має 15 хв wall time.
// 25 MB це ~50 хв аудіо iPhone (~64 kbps) або ~100 хв при 32 kbps, тобто з запасом.
const TRANSCRIBE_MAX_BYTES = 25_000_000;
const TELEGRAM_MAX_BYTES = 50_000_000; // ліміт Bot API на upload: 50 MB
const CAPTION_MAX = 1024;
const LATEST_SNAPSHOT_KEY = "things/latest-snapshot.json"; // для голосових з Telegram

// Кладе аудіо в R2 (разом зі знімком Things, якщо є) і ставить у чергу.
async function enqueueNote(
	env: Env,
	key: string,
	body: ArrayBuffer,
	contentType: string,
	snapshot: ThingsSnapshot | null,
	customMetadata?: Record<string, string | undefined>,
	edit?: string,
): Promise<void> {
	const meta = Object.fromEntries(Object.entries(customMetadata ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
	await env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: meta });
	if (snapshot) await env.BUCKET.put(`${key}.things.json`, JSON.stringify(snapshot));
	await env.QUEUE.send(edit ? { key, edit } : { key });
}

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);

		// Сторінка кнопки «Додати в Things» (без секрету: id випадковий і одноразовий).
		const link = url.pathname.match(/^\/things\/([0-9a-f-]{36})$/);
		if (link && req.method === "GET") return handleThingsLink(env, link[1], url.searchParams.has("force"));

		// Кнопка «Редагувати»: відкриває шорткат з edit:<id> на вході (Telegram-кнопки підтримують лише http(s)).
		const editLink = url.pathname.match(/^\/edit\/([0-9a-f-]{36})$/);
		if (editLink && req.method === "GET") {
			if (!(await env.BUCKET.head(noteKey(editLink[1])))) {
				return page("Нотатка застаріла", "<p>Редагувати можна протягом 7 днів.</p>", 404);
			}
			const href = `shortcuts://run-shortcut?name=${encodeURIComponent(env.SHORTCUT_NAME)}&input=text&text=edit:${editLink[1]}`;
			return page(
				"Редагування нотатки",
				`<p>Запиши, що змінити. Якщо шорткат не відкрився:</p><p><a class="btn" href="${href}">Відкрити шорткат</a></p>`,
				200,
				`<meta http-equiv="refresh" content="0;url=${href}">`,
			);
		}

		// Вебхук Telegram: голосові й аудіо, надіслані боту в особистий чат.
		if (url.pathname === "/telegram" && req.method === "POST") {
			const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
			if (!env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
				return new Response("unauthorized", { status: 401 });
			}
			type Msg = Parameters<typeof receiveTelegramVoice>[1];
			const update = (await req.json()) as { message?: Msg; channel_post?: Msg };
			const msg = update.message ?? update.channel_post;
			if (msg) {
				await receiveTelegramVoice(env, msg, async (key, body, { contentType, replyTo, ...meta }) => {
					// Знімка від шорткату тут немає, тож беремо останній збережений.
					const snapshot = await (await env.BUCKET.get(LATEST_SNAPSHOT_KEY))?.json<ThingsSnapshot>();
					// Відповідь на повідомлення в каналі = редагування; "missing", якщо це не наша нотатка або вона застаріла.
					const edit = replyTo && ((await (await env.BUCKET.get(noteByMessageKey(replyTo)))?.text()) || "missing");
					await enqueueNote(env, key, body, contentType, snapshot ?? null, meta, edit || undefined);
				});
			}
			return new Response("ok");
		}

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
		let edit: string | undefined; // поле edit = Shortcut Input; при запуску з кнопки «Редагувати» це edit:<id>
		if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
			const form = await req.formData();
			const audio = form.get("audio");
			if (!audio || typeof audio === "string") return new Response("missing audio field", { status: 400 });
			body = await audio.arrayBuffer();
			snapshot = snapshotFromForm(form);
			edit = String(form.get("edit") ?? "").match(/edit:([0-9a-f-]{36})/)?.[1];
		} else {
			body = await req.arrayBuffer();
		}
		if (body.byteLength === 0) return new Response("empty body", { status: 400 });

		const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.m4a`;
		await enqueueNote(env, key, body, "audio/mp4", snapshot, undefined, edit);
		if (snapshot) await env.BUCKET.put(LATEST_SNAPSHOT_KEY, JSON.stringify(snapshot));
		return new Response("ok");
	},

	// ---------- Consumers ----------
	async queue(batch, env): Promise<void> {
		if (batch.queue === DLQ_NAME) {
			for (const msg of batch.messages) {
				await tgSendMessage(
					env,
					env.CHAT_ID,
					`⚠️ Не вдалося обробити голосовий запис після ${MAX_RETRIES + 1} спроб.\n` +
						`Ключ: ${msg.body.key}\nФайл лишається в R2 (бакет voice-notes) до 7 днів.`,
				);
				msg.ack();
			}
			return;
		}

		for (const msg of batch.messages) {
			try {
				const last = msg.attempts > MAX_RETRIES;
				if (msg.body.edit) await processEdit(env, msg.body.key, msg.body.edit, last);
				else await processNote(env, msg.body.key, last);
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
	const contentType = obj.httpMetadata?.contentType ?? "audio/mp4";
	// Тіло об'єкта R2 читається лише раз, тож кешуємо.
	let data: ArrayBuffer | undefined;
	const read = async () => (data ??= await obj.arrayBuffer());
	// Аудіо з Telegram пересилаємо за file_id, з шорткату — завантажуємо в Telegram заново.
	const source = {
		blob: async () => new Blob([await read()], { type: contentType }),
		fileId: obj.customMetadata?.fileId,
		kind: obj.customMetadata?.kind,
	};

	// Задовгий для транскрипції в межах 15 хв: не ретраїмо, шлемо оригінал без транскрипту.
	if (obj.size > TRANSCRIBE_MAX_BYTES) {
		if (!state.audioSent) {
			const mb = (obj.size / 1_000_000).toFixed(1);
			if (obj.size > TELEGRAM_MAX_BYTES) {
				await tgSendMessage(
					env,
					env.CHAT_ID,
					`🎙 Запис ${recordedAt} (${mb} МБ) завеликий і для транскрипції (ліміт 25 МБ), і для Telegram-бота (50 МБ).\n` +
						`Ключ: ${key}. Файл лишається в R2 до 7 днів.`,
				);
			} else {
				await tgSendNote(
					env,
					source,
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

	if (state.transcript === undefined) {
		state.transcript = await transcribe(env, await read(), contentType);
		await save();
	}
	if (state.meta === undefined) {
		state.meta = await summarize(env, state.transcript, recordedAt, lastAttempt);
		await save();
	}
	const meta = state.meta;

	// Тиша, шум або голосове «скасуй»: нічого не публікуємо, прибираємо все, включно з оригіналом у каналі.
	if (meta.discard) {
		console.log(`${key} discarded: ${meta.discard}`);
		await deleteOriginal(env, obj.customMetadata);
		await env.BUCKET.delete([key, stateKey, thingsKey]);
		return;
	}

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
		state.thingsLinkId = await createThingsLink(env, newTasks, `🎙 ${meta.title} (${recordedAt})`);
		console.log(`things link ${state.thingsLinkId}: ${newTasks.length} new, ${state.triage!.length - newTasks.length} duplicates`);
		// Telegram не приймає localhost у кнопках, тож при локальному запуску посилання беремо з логу.
		if (env.LOCAL_DEV) console.log(`open locally: http://localhost:8787/things/${state.thingsLinkId}`);
		await save();
	}

	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	if (!state.audioSent) {
		state.noteId ??= crypto.randomUUID();
		const caption = buildCaption(meta, state.triage ?? null, recordedTs(key), env.TIMEZONE);
		const buttons = noteButtons(env, state.noteId, state.thingsLinkId, newTasks.length);
		state.messageId = await tgSendNote(env, source, meta.title, caption, buttons);
		state.audioSent = true;
		await save();
	}

	// Посилання на повідомлення в нотатки задач Things (лише для каналів і супергруп).
	const messageUrl = state.messageId && telegramMessageUrl(env.CHAT_ID, state.messageId);
	if (state.thingsLinkId && messageUrl && !state.messageLinked) {
		await setThingsLinkMessage(env, state.thingsLinkId, messageUrl);
		state.messageLinked = true;
		await save();
	}

	// Зберігаємо нотатку для редагування (повторний запис при ретраї нічого не ламає).
	if (state.noteId && state.messageId) {
		const note: Note = {
			transcript: state.transcript,
			edits: [],
			meta,
			triage: state.triage ?? null,
			thingsLinkId: state.thingsLinkId,
			messageId: state.messageId,
			recordedTs: recordedTs(key),
		};
		await env.BUCKET.put(noteKey(state.noteId), JSON.stringify(note));
		await env.BUCKET.put(noteByMessageKey(state.messageId), state.noteId);
		console.log(`note ${state.noteId} published as message ${state.messageId}`);
	}

	// Голосове, надіслане в канал, видаляємо: нотатка вище містить те саме аудіо.
	if (!state.originalDeleted) {
		await deleteOriginal(env, obj.customMetadata);
		state.originalDeleted = true;
		await save();
	}

	await env.BUCKET.delete([key, stateKey, thingsKey]);
}

// ---------- Редагування нотатки голосовою інструкцією ----------
async function processEdit(env: Env, key: string, noteId: string, lastAttempt: boolean): Promise<void> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return; // уже оброблено
	const stateKey = `${key}.state.json`;
	const thingsKey = `${key}.things.json`;
	// Поки редагуємо, на нотатці стоїть 👨‍💻 (✏ серед реакцій для ботів немає).
	const markEditing = (on: boolean, messageId: number) =>
		tg(env, "setMessageReaction", {
			chat_id: env.CHAT_ID,
			message_id: messageId,
			reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [],
		}).catch((err) => console.error("reaction failed:", err));
	const cleanup = async (messageId?: number) => {
		if (messageId) await markEditing(false, messageId);
		await deleteOriginal(env, obj.customMetadata); // інструкцію з каналу прибираємо
		await env.BUCKET.delete([key, stateKey, thingsKey]);
	};
	const state: State = (await (await env.BUCKET.get(stateKey))?.json<State>()) ?? {};
	const save = () => env.BUCKET.put(stateKey, JSON.stringify(state));

	const note = await (await env.BUCKET.get(noteKey(noteId)))?.json<Note>();
	if (!note) {
		await tgSendMessage(env, env.CHAT_ID, "⚠️ Не вдалося відредагувати: нотатку не знайдено (редагувати можна протягом 7 днів).");
		await cleanup();
		return;
	}

	if (state.transcript === undefined) {
		await markEditing(true, note.messageId);
		state.transcript = await transcribe(env, await obj.arrayBuffer(), obj.httpMetadata?.contentType ?? "audio/mp4");
		await save();
	}
	const instruction = state.transcript;
	if (state.meta === undefined) {
		const edited = instruction ? await editNote(env, note, instruction) : null;
		if (instruction && !edited && !lastAttempt) throw new Error("All edit models failed");
		// Порожня інструкція або (на останній спробі) збій моделей: нотатку лишаємо як є.
		state.meta = edited ?? { title: "", summary: "", ideas: [], tasks: [], discard: "empty" };
		await save();
	}
	const meta = state.meta;
	if (meta.discard) {
		console.log(`edit ${noteId} discarded: ${meta.discard}`);
		await cleanup(note.messageId);
		return;
	}

	// Тріаж заново: транскрипт разом з усіма правками, щоб дати й пріоритети бралися з них.
	const fullTranscript = [note.transcript, ...note.edits, instruction].join("\n\n[Правка автора]: ");
	if (state.triage === undefined) {
		const snap = meta.tasks.length
			? ((await (await env.BUCKET.get(thingsKey))?.json<ThingsSnapshot>()) ??
				(await (await env.BUCKET.get(LATEST_SNAPSHOT_KEY))?.json<ThingsSnapshot>()))
			: null;
		state.triage = snap ? await triage(env, fullTranscript, meta.tasks, snap, new Date(note.recordedTs), env.TIMEZONE) : null;
		await save();
	}
	const newTasks = state.triage?.filter((i) => !i.duplicateOf) ?? [];
	const messageUrl = telegramMessageUrl(env.CHAT_ID, note.messageId);
	if (newTasks.length && !state.thingsLinkId) {
		state.thingsLinkId = await createThingsLink(env, newTasks, `🎙 ${meta.title} (${formatRecordedAt(String(note.recordedTs), env.TIMEZONE)})`);
		if (messageUrl) await setThingsLinkMessage(env, state.thingsLinkId, messageUrl);
		await save();
	}

	if (!state.captionEdited) {
		// Things не дає змінити вже додані задачі, тож попереджаємо, що нова кнопка додасть їх як нові.
		const alreadyAdded = note.thingsLinkId && newTasks.length && (await thingsLinkUsed(env, note.thingsLinkId));
		const caption = buildCaption(
			meta,
			state.triage ?? null,
			note.recordedTs,
			env.TIMEZONE,
			alreadyAdded ? "ℹ️ Попередні задачі вже додавались у Things: кнопка додасть змінені як нові." : "",
		);
		await tg(env, "editMessageCaption", {
			chat_id: env.CHAT_ID,
			message_id: note.messageId,
			caption,
			reply_markup: noteButtons(env, noteId, state.thingsLinkId, newTasks.length),
		}).catch((err) => {
			if (!String(err).includes("message is not modified")) throw err;
		});
		state.captionEdited = true;
		await save();
	}

	const updated: Note = { ...note, edits: [...note.edits, instruction], meta, triage: state.triage ?? null, thingsLinkId: state.thingsLinkId };
	await env.BUCKET.put(noteKey(noteId), JSON.stringify(updated));
	if (note.thingsLinkId && note.thingsLinkId !== state.thingsLinkId) await env.BUCKET.delete(`things/${note.thingsLinkId}.json`);
	console.log(`note ${noteId} edited`);
	await cleanup(note.messageId);
}

// Кнопки під нотаткою: «Додати в Things» (якщо є нові задачі) і «Редагувати».
function noteButtons(env: Env, noteId: string, thingsLinkId: string | undefined, count: number) {
	const row = [{ text: "✏️ Редагувати", url: `${env.PUBLIC_URL}/edit/${noteId}` }];
	if (thingsLinkId) row.unshift({ text: `➕ Додати в Things (${count})`, url: `${env.PUBLIC_URL}/things/${thingsLinkId}` });
	return { inline_keyboard: [row] };
}

// Підпис з хештегами окремим рядком у кінці: вони не обрізаються разом з довгим текстом.
function buildCaption(meta: Meta, triaged: TriageItem[] | null, ts: number, timeZone: string, notice = ""): string {
	const tail = [notice, hashtags(new Date(ts), timeZone, triaged)].filter(Boolean).join("\n\n");
	return `${truncate(formatCaption(meta, triaged), CAPTION_MAX - tail.length - 2)}\n\n${tail}`;
}

// Видаляє оригінальне голосове з каналу (якщо запис прийшов звідти). Збій не критичний.
async function deleteOriginal(env: Env, meta: Record<string, string> | undefined): Promise<void> {
	const { deleteChatId, deleteMessageId } = meta ?? {};
	if (!deleteChatId || !deleteMessageId) return;
	await tg(env, "deleteMessage", { chat_id: deleteChatId, message_id: Number(deleteMessageId) }).catch((err) =>
		console.error("delete original voice failed:", err),
	);
}

// ---------- Workers AI: whisper-large-v3-turbo ----------
async function transcribe(env: Env, audio: ArrayBuffer, contentType: string): Promise<string> {
	// Аудіо передаємо потоком (без base64): m4a з шорткату або ogg/opus з Telegram.
	// Автор завжди говорить українською, тож задаємо мову явно, щоб модель не сплутала її з російською.
	const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
		audio: { body: new Blob([audio]).stream(), contentType },
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
- If there are no ideas or no tasks, return an empty array for that field. Do not invent anything that is not in the transcript.
- discard: normally "none". Use "empty" when the transcript has no meaningful content: silence, noise, filler, or typical speech-recognition hallucinations on silence ("Дякую за перегляд", "Субтитри зроблені…", "Продовження наступне", a single repeated word). Use "cancelled" when the author explicitly asks to cancel, discard or not save this whole recording ("скасуй", "відміна, не зберігай", "видали цей запис", "забудь, не надсилай"), usually at the end. A cancel phrase that is about a real-world thing ("скасувати зустріч", "відмінити підписку") is a task, not "cancelled". When discard is not "none", the other fields may be empty.`;

// Structured output: модель повертає JSON саме такої форми.
const SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		summary: { type: "string" },
		ideas: { type: "array", items: { type: "string" } },
		tasks: { type: "array", items: { type: "string" } },
		discard: { type: "string", enum: ["none", "empty", "cancelled"] },
	},
	required: ["title", "summary", "ideas", "tasks", "discard"],
	additionalProperties: false,
};

type Meta = { title: string; summary: string; ideas: string[]; tasks: string[]; discard?: "empty" | "cancelled" };

async function summarize(env: Env, transcript: string, recordedAt: string, lastAttempt: boolean): Promise<Meta> {
	if (!transcript) return { title: "", summary: "", ideas: [], tasks: [], discard: "empty" };

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

const EDIT_SYSTEM = `${SYSTEM_PROMPT}

Editing mode: you get an existing note (<note> JSON), its original transcript, earlier edit instructions and a new spoken edit instruction from the author.
Return the full updated note. Apply exactly what the instruction asks (rename, add, remove, reword, change dates or details of tasks, etc.) and keep everything else unchanged.
In editing mode, discard means: "cancelled" if the author cancels this edit itself ("скасуй", "нічого не міняй"); "empty" if the instruction has no meaningful content; otherwise "none".`;

async function editNote(env: Env, note: Note, instruction: string): Promise<Meta | null> {
	const { title, summary, ideas, tasks } = note.meta;
	const user = [
		`<note>\n${JSON.stringify({ title, summary, ideas, tasks })}\n</note>`,
		`<transcript>\n${note.transcript}\n</transcript>`,
		note.edits.length ? `<earlier_edits>\n${note.edits.join("\n")}\n</earlier_edits>` : "",
		`<instruction>\n${instruction}\n</instruction>`,
	].filter(Boolean).join("\n\n");
	return askJson(env, { name: "voice_note_edit", system: EDIT_SYSTEM, user, schema: SUMMARY_SCHEMA }, parseMeta);
}

function parseMeta(text: string): Meta {
	const json = parseJsonObject(text);
	if (json.discard === "empty" || json.discard === "cancelled") {
		return { title: "", summary: "", ideas: [], tasks: [], discard: json.discard };
	}
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

// Хештеги для навігації в каналі: місяць, ISO-тиждень (у TIMEZONE) і області нових задач.
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];

function hashtags(date: Date, timeZone: string, triaged: TriageItem[] | null): string {
	const [y, m, d] = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date).split("-").map(Number);
	const week = isoWeek(y, m, d);
	const lists = [...new Set((triaged ?? []).filter((i) => !i.duplicateOf && i.list).map((i) => i.list))];
	return [`#${MONTHS[m - 1]}_${y}`, `#тиждень_${week}`, ...lists.map((l) => `#${l.replace(/[^\p{L}\p{N}_]+/gu, "_")}`)].join(" ");
}

// ISO-тиждень: номер тижня, що містить четвер цього тижня (тижні з понеділка).
function isoWeek(y: number, m: number, d: number): number {
	const thursday = new Date(Date.UTC(y, m - 1, d));
	thursday.setUTCDate(d + 3 - ((thursday.getUTCDay() + 6) % 7));
	const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
	return Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
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

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
