import { askJson } from "./llm";
import { buildCaption, parseEditedNote, parseMeta, plainTasks, type Meta } from "./note";
import { receiveTelegramVoice, telegramMessageUrl, tg, tgSendMessage, tgSendNote } from "./telegram";
import {
	applyAction,
	createAction,
	deleteAction,
	EDIT_TASKS_HELP,
	fetchSnapshot,
	getInTodoist,
	planOps,
	promptDate,
	setActionMessage,
	taskFieldsSchema,
	taskRulesBlock,
	taskValidator,
	triage,
	type TodoistOp,
	type TodoistSnapshot,
	type TriageItem,
} from "./todoist";

export interface Env {
	AI: Ai;
	BUCKET: R2Bucket;
	QUEUE: Queue<Job>;
	// secrets
	SECRET: string;
	OPENAI_KEY?: string; // для gpt-6-luna; без нього одразу Gemma
	BOT_TOKEN: string;
	CHAT_ID: string; // куди надсилати нотатки (канал)
	TG_WEBHOOK_SECRET?: string; // секрет вебхука Telegram
	TG_OWNER_ID?: string; // Telegram user id власника: голосові в приваті й натискання кнопок
	TODOIST_TOKEN?: string; // без нього нотатки йдуть без тріажу задач
	// vars
	TIMEZONE: string;
	PUBLIC_URL: string; // адреса воркера для кнопки «Редагувати»
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
	actionId?: string; // дія для кнопки Todoist ("" — робити нічого)
	actionLabel?: string; // «➕ Додати в Todoist (N)» або «🔄 Оновити в Todoist (N)»
	audioSent?: boolean;
	messageId?: number; // id повідомлення з аудіо в Telegram
	messageLinked?: boolean; // посилання на повідомлення дописане в дію
	originalDeleted?: boolean; // оригінальне голосове з каналу видалене
	noteId?: string; // id нотатки (кнопка «Редагувати»), створюється до відправки
	captionEdited?: boolean; // (редагування) підпис нотатки вже оновлено
};

// Опублікована нотатка, зберігається для редагування (`notes/<id>.json`, 7 днів за lifecycle бакета).
// `notes/msg-<message_id>` вказує на id нотатки: так відповідь у каналі знаходить, що редагувати.
type Note = {
	transcript: string;
	edits: string[]; // інструкції попередніх редагувань
	meta: Meta;
	triage: TriageItem[] | null;
	actionId?: string;
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

// Кладе аудіо в R2 і ставить у чергу.
async function enqueueNote(
	env: Env,
	key: string,
	body: ArrayBuffer,
	contentType: string,
	customMetadata?: Record<string, string | undefined>,
	edit?: string,
): Promise<void> {
	const meta = Object.fromEntries(Object.entries(customMetadata ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
	await env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: meta });
	await env.QUEUE.send(edit ? { key, edit } : { key });
}

type TgCallback = { id: string; from: { id: number }; data?: string };

export default {
	async fetch(req, env): Promise<Response> {
		const url = new URL(req.url);

		// Кнопка «Редагувати»: відкриває шорткат з edit:<id> на вході (url-кнопки Telegram підтримують лише http(s)).
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

		// Вебхук Telegram: голосові (канал і приват) і натискання кнопки Todoist.
		if (url.pathname === "/telegram" && req.method === "POST") {
			const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
			if (!env.TG_WEBHOOK_SECRET || !(await safeEqual(token, env.TG_WEBHOOK_SECRET))) {
				return new Response("unauthorized", { status: 401 });
			}
			type Msg = Parameters<typeof receiveTelegramVoice>[1];
			const update = (await req.json()) as { message?: Msg; channel_post?: Msg; callback_query?: TgCallback };
			if (update.callback_query) {
				await handleCallback(env, update.callback_query);
				return new Response("ok");
			}
			const msg = update.message ?? update.channel_post;
			if (msg) {
				await receiveTelegramVoice(env, msg, async (key, body, { contentType, replyTo, ...meta }) => {
					// Відповідь на повідомлення в каналі = редагування; "missing", якщо це не наша нотатка або вона застаріла.
					const edit = replyTo && ((await (await env.BUCKET.get(noteByMessageKey(replyTo)))?.text()) || "missing");
					await enqueueNote(env, key, body, contentType, meta, edit || undefined);
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

		// Два формати: сирий файл у тілі або форма (audio + edit). Інші поля форми ігноруються.
		// Тіло читаємо повністю (не стрімом): R2 put потребує відомої довжини.
		let body: ArrayBuffer;
		let edit: string | undefined; // поле edit = Shortcut Input; при запуску з кнопки «Редагувати» це edit:<id>
		if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
			const form = await req.formData();
			const audio = form.get("audio");
			if (!audio || typeof audio === "string") return new Response("missing audio field", { status: 400 });
			body = await audio.arrayBuffer();
			edit = String(form.get("edit") ?? "").match(/edit:([0-9a-f-]{36})/)?.[1];
		} else {
			body = await req.arrayBuffer();
		}
		if (body.byteLength === 0) return new Response("empty body", { status: 400 });

		const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.m4a`;
		await enqueueNote(env, key, body, "audio/mp4", undefined, edit);
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

// Знімок Todoist для тріажу; без токена або при збої — null (нотатка прийде без тріажу).
async function todoistSnapshot(env: Env): Promise<TodoistSnapshot | null> {
	if (!env.TODOIST_TOKEN) return null;
	try {
		return await fetchSnapshot(env);
	} catch (err) {
		console.error("todoist snapshot failed:", err);
		return null;
	}
}

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
		await env.BUCKET.delete([key, stateKey]);
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
		await env.BUCKET.delete([key, stateKey]);
		return;
	}

	// Тріаж задач для Todoist. Невдалий тріаж не блокує нотатку: вона прийде без кнопки.
	if (state.triage === undefined) {
		const snap = meta.tasks.length ? await todoistSnapshot(env) : null;
		state.triage = snap
			? await triage(env, state.transcript, meta.tasks, snap, new Date(recordedTs(key)), env.TIMEZONE)
			: null;
		await save();
	}
	const newTasks = state.triage?.filter((i) => !i.duplicateOf) ?? [];
	state.noteId ??= crypto.randomUUID();
	if (newTasks.length && !state.actionId) {
		const ops: TodoistOp[] = newTasks.map((item) => ({ key: item.key ?? "", item }));
		state.actionId = await createAction(env, ops, `🎙 ${meta.title} (${recordedAt})`, state.noteId);
		state.actionLabel = `➕ Додати в Todoist (${ops.length})`;
		console.log(`todoist action ${state.actionId}: ${newTasks.length} new, ${state.triage!.length - newTasks.length} duplicates`);
		await save();
	}

	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	if (!state.audioSent) {
		const caption = buildCaption(meta, state.triage ?? null, recordedTs(key), env.TIMEZONE);
		const buttons = noteButtons(env, state.noteId, state.actionId, state.actionLabel);
		state.messageId = await tgSendNote(env, source, meta.title, caption, buttons);
		state.audioSent = true;
		await save();
	}

	// Посилання на повідомлення в описі задач Todoist (лише для каналів і супергруп).
	const messageUrl = state.messageId && telegramMessageUrl(env.CHAT_ID, state.messageId);
	if (state.actionId && messageUrl && !state.messageLinked) {
		await setActionMessage(env, state.actionId, messageUrl);
		state.messageLinked = true;
		await save();
	}

	// Зберігаємо нотатку для редагування (повторний запис при ретраї нічого не ламає).
	if (state.messageId) {
		const note: Note = {
			transcript: state.transcript,
			edits: [],
			meta,
			triage: state.triage ?? null,
			actionId: state.actionId || undefined,
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

	await env.BUCKET.delete([key, stateKey]);
}

// ---------- Редагування нотатки голосовою інструкцією ----------
async function processEdit(env: Env, key: string, noteId: string, lastAttempt: boolean): Promise<void> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return; // уже оброблено
	const stateKey = `${key}.state.json`;
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
		await env.BUCKET.delete([key, stateKey]);
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
		const snap = await todoistSnapshot(env);
		const edited = instruction ? await editNote(env, note, instruction, snap) : null;
		if (instruction && !edited && !lastAttempt) throw new Error("All edit models failed");
		// Порожня інструкція або (на останній спробі) збій моделей: нотатку лишаємо як є.
		state.meta = edited?.meta ?? { title: "", summary: "", ideas: [], tasks: [], discard: "empty" };
		state.triage = edited?.triage ?? null;
		await save();
	}
	const meta = state.meta;
	if (meta.discard) {
		console.log(`edit ${noteId} discarded: ${meta.discard}`);
		await cleanup(note.messageId);
		return;
	}

	// Порівнюємо з тим, що вже є в Todoist: змінені задачі оновлюємо, нові створюємо, прибрані видаляємо.
	const inTodoist = await getInTodoist(env, noteId);
	if (state.actionId === undefined) {
		const ops = state.triage ? planOps(state.triage, inTodoist) : [];
		if (ops.length) {
			const recorded = formatRecordedAt(String(note.recordedTs), env.TIMEZONE);
			state.actionId = await createAction(env, ops, `🎙 ${meta.title} (${recorded})`, noteId);
			const messageUrl = telegramMessageUrl(env.CHAT_ID, note.messageId);
			if (messageUrl) await setActionMessage(env, state.actionId, messageUrl);
			state.actionLabel = ops.some((op) => op.id) ? `🔄 Оновити в Todoist (${ops.length})` : `➕ Додати в Todoist (${ops.length})`;
			const n = (f: (op: TodoistOp) => boolean) => ops.filter(f).length;
			console.log(
				`todoist action ${state.actionId}: ${n((o) => !o.id)} create, ${n((o) => !!o.id && !!o.item)} update, ${n((o) => !o.item)} delete`,
			);
		} else {
			state.actionId = "";
		}
		await save();
	}

	if (!state.captionEdited) {
		const caption = buildCaption(meta, state.triage ?? null, note.recordedTs, env.TIMEZONE, "", new Set(Object.keys(inTodoist)));
		await editNoteMessage(env, note.messageId, caption, noteButtons(env, noteId, state.actionId, state.actionLabel));
		state.captionEdited = true;
		await save();
	}

	const updated: Note = {
		...note,
		edits: [...note.edits, instruction],
		meta,
		triage: state.triage ?? null,
		actionId: state.actionId || undefined,
	};
	await env.BUCKET.put(noteKey(noteId), JSON.stringify(updated));
	// Стара дія (якщо її не натиснули) більше не актуальна.
	if (note.actionId && note.actionId !== state.actionId) await deleteAction(env, note.actionId);
	console.log(`note ${noteId} edited`);
	await cleanup(note.messageId);
}

// ---------- Кнопка Todoist (callback_query) ----------
async function handleCallback(env: Env, cb: TgCallback): Promise<void> {
	const answer = (text: string, alert = false) =>
		tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert }).catch((err) =>
			console.error("answerCallbackQuery failed:", err),
		);
	if (env.TG_OWNER_ID && String(cb.from.id) !== env.TG_OWNER_ID) return void (await answer("Немає доступу"));
	const id = cb.data?.match(/^td:([0-9a-f-]{36})$/)?.[1];
	if (!id) return void (await answer(""));
	try {
		const res = await applyAction(env, id);
		if (res.status === "missing") return void (await answer("Дія застаріла (зберігається 7 днів)", true));
		if (res.status === "already") return void (await answer("Вже виконано"));
		console.log(`todoist action ${id} applied: ${res.count} ops`);
		await answer(`✅ Todoist: ${res.count}`);
		await markInTodoist(env, res.noteId).catch((err) => console.error("mark in todoist failed:", err));
	} catch (err) {
		console.error(`todoist action ${id} failed:`, err);
		await answer("⚠️ Не вдалося оновити Todoist, спробуй ще раз", true);
	}
}

// Після виконання дії: ☑️ біля задач, що вже в Todoist, і без кнопки Todoist.
async function markInTodoist(env: Env, noteId: string): Promise<void> {
	const note = await (await env.BUCKET.get(noteKey(noteId)))?.json<Note>();
	if (!note) return;
	const inTodoist = new Set(Object.keys(await getInTodoist(env, noteId)));
	const caption = buildCaption(note.meta, note.triage, note.recordedTs, env.TIMEZONE, "", inTodoist);
	await editNoteMessage(env, note.messageId, caption, noteButtons(env, noteId, undefined, undefined));
}

async function editNoteMessage(env: Env, messageId: number, caption: string, replyMarkup: object): Promise<void> {
	await tg(env, "editMessageCaption", { chat_id: env.CHAT_ID, message_id: messageId, caption, reply_markup: replyMarkup }).catch(
		(err) => {
			if (!String(err).includes("message is not modified")) throw err;
		},
	);
}

// Кнопки під нотаткою: «Додати / Оновити в Todoist» (якщо є що робити) і «Редагувати».
function noteButtons(env: Env, noteId: string, actionId: string | undefined, actionLabel: string | undefined) {
	const row: object[] = [{ text: "✏️ Редагувати", url: `${env.PUBLIC_URL}/edit/${noteId}` }];
	if (actionId) row.unshift({ text: actionLabel ?? "➕ Додати в Todoist", callback_data: `td:${actionId}` });
	return { inline_keyboard: [row] };
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
Return the full updated note. Apply exactly what the instruction asks (rename, add, remove, reword, change dates, projects, labels or priority of tasks, etc.) and keep everything else unchanged.
Tasks: return every task that should remain, in order. An existing task keeps its "key" even if you change its title or fields; a new task gets key "". A removed task is simply omitted.
${EDIT_TASKS_HELP}
Relative dates in the instruction ("сьогодні", "завтра", "в п'ятницю") are counted from the edit date; in the original transcript, from the recording date.
In editing mode, discard means: "cancelled" if the author cancels this edit itself ("скасуй", "нічого не міняй"); "empty" if the instruction has no meaningful content; otherwise "none".`;

async function editNote(
	env: Env,
	note: Note,
	instruction: string,
	snap: TodoistSnapshot | null,
): Promise<{ meta: Meta; triage: TriageItem[] | null } | null> {
	const { title, summary, ideas } = note.meta;
	const oldTasks = note.triage ?? plainTasks(note.meta.tasks);
	const tasks = oldTasks.map(({ key, title, project, labels, priority, due, deadline, duplicateOf }) =>
		snap
			? { key, title, project, labels, priority: `p${priority}`, due, deadline, ...(duplicateOf && { already_exists_as: duplicateOf }) }
			: { key, title },
	);
	const taskSchema = {
		type: "object",
		properties: { key: { type: "string" }, title: { type: "string" }, ...(snap ? taskFieldsSchema(snap) : {}) },
		required: snap ? ["key", "title", "project", "labels", "priority", "due", "deadline"] : ["key", "title"],
		additionalProperties: false,
	};
	const schema = {
		...SUMMARY_SCHEMA,
		properties: { ...SUMMARY_SCHEMA.properties, tasks: { type: "array", items: taskSchema } },
	};
	const now = new Date();
	const user = [
		`Recording date: ${promptDate(new Date(note.recordedTs), env.TIMEZONE)}`,
		`Edit date: ${promptDate(now, env.TIMEZONE)}`,
		snap ? taskRulesBlock(snap) : "",
		`<note>\n${JSON.stringify({ title, summary, ideas, tasks })}\n</note>`,
		`<transcript>\n${note.transcript}\n</transcript>`,
		note.edits.length ? `<earlier_edits>\n${note.edits.join("\n")}\n</earlier_edits>` : "",
		`<instruction>\n${instruction}\n</instruction>`,
	]
		.filter(Boolean)
		.join("\n\n");

	// "today"/"tomorrow" у правці рахуються від дати правки.
	const validate = snap ? taskValidator(snap, now, env.TIMEZONE) : null;
	return askJson(env, { name: "voice_note_edit", system: EDIT_SYSTEM, user, schema }, (text) =>
		parseEditedNote(text, oldTasks, validate),
	);
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
