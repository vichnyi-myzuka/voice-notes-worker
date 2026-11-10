import { askJson, parseJsonObject, toBase64 } from "./llm";
import { buildCaption, CAPTION_MAX, parseEditedNote, parseMeta, plainTasks, taskLinks, textNote, TEXT_CAPTION_MAX, type Meta } from "./note";
import { applySetup, planSetup, setupReport, type SetupPlan } from "./setup";
import { openSteps } from "./steps";
import { NO_PREVIEW, receiveTelegramVoice, telegramMessageUrl, tg, tgSendMessage, tgSendNote, tgSendText } from "./telegram";
import {
	applyAction,
	attachFile,
	createAction,
	deleteAction,
	deleteOpenTasks,
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
	withAppliedRecurrence,
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
	actionId?: string; // дія в Todoist ("" — робити нічого)
	todoistApplied?: boolean; // дію виконано (false — не вдалося навіть на останній спробі)
	todoistMarked?: boolean; // підпис з посиланнями на задачі оновлено після виконання
	audioSent?: boolean;
	messageId?: number; // id повідомлення з аудіо в Telegram
	messageLinked?: boolean; // посилання на повідомлення дописане в дію
	originalDeleted?: boolean; // оригінальне голосове з каналу видалене
	noteId?: string; // id нотатки для редагування й дії Todoist, створюється до відправки
	captionEdited?: boolean; // (редагування) підпис нотатки вже оновлено
	setup?: { id: string; plan: SetupPlan; ok?: boolean } | null; // команди налаштування Todoist (null — немає)
	photoAttached?: boolean; // (фото) фото додане коментарем до створених задач
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
	text?: boolean; // текстова нотатка: повідомлення без аудіо, оригінал — у цитаті під підписом
	setup?: string[]; // зміни налаштувань Todoist, зроблені цією нотаткою та її правками (для підпису)
};
const noteKey = (id: string) => `notes/${id}.json`;
const noteByMessageKey = (messageId: number | string) => `notes/msg-${messageId}`;
// Підпис до фото — окремим об'єктом: у customMetadata R2 (2 КБ) 1024 символи кирилиці можуть не влізти.
const captionKey = (key: string) => `${key}.caption`;

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
				await receiveTelegramVoice(env, msg, async (key, body, { contentType, replyTo, caption, ...meta }) => {
					if (caption) await env.BUCKET.put(captionKey(key), caption);
					// Відповідь на повідомлення в каналі = редагування; "missing", якщо це не наша нотатка або вона застаріла.
					const edit = replyTo && ((await (await env.BUCKET.get(noteByMessageKey(replyTo)))?.text()) || "missing");
					if (!edit || edit === "missing") {
						await enqueueNote(env, key, body, contentType, meta, edit || undefined);
						return true;
					}
					// Правка: відповідь одразу прибираємо з каналу, а статус «редагується» (👨‍💻) — на самій нотатці.
					const { deleteChatId, deleteMessageId, ...rest } = meta;
					await enqueueNote(env, key, body, contentType, rest, edit);
					await markEditing(env, Number(replyTo), true);
					await deleteOriginal(env, { deleteChatId: deleteChatId ?? "", deleteMessageId: deleteMessageId ?? "" });
					return false;
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

		// Два формати: сирий файл у тілі або форма з полем audio (інші поля ігноруються).
		// Тіло читаємо повністю (не стрімом): R2 put потребує відомої довжини.
		let body: ArrayBuffer;
		if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
			const audio = (await req.formData()).get("audio");
			if (!audio || typeof audio === "string") return new Response("missing audio field", { status: 400 });
			body = await audio.arrayBuffer();
		} else {
			body = await req.arrayBuffer();
		}
		if (body.byteLength === 0) return new Response("empty body", { status: 400 });

		const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.m4a`;
		await enqueueNote(env, key, body, "audio/mp4");
		return new Response("ok");
	},

	// ---------- Consumers ----------
	async queue(batch, env): Promise<void> {
		if (batch.queue === DLQ_NAME) {
			for (const msg of batch.messages) {
				// Правка не вдалася: знімаємо з нотатки статус «редагується».
				const note = msg.body.edit && (await (await env.BUCKET.get(noteKey(msg.body.edit)))?.json<Note>());
				if (note) await markEditing(env, note.messageId, false);
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
	const { state, save, step } = await openSteps<State>(env, stateKey, lastAttempt);
	const recordedAt = formatRecordedAt(key, env.TIMEZONE);
	const contentType = obj.httpMetadata?.contentType ?? "audio/mp4";
	const isText = contentType.startsWith("text/"); // написаний текст: він і є транскриптом
	const isPhoto = contentType.startsWith("image/"); // фото: «транскрипт» — підпис і текст із зображення
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
		await step("audioSent", async () => {
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
			return true;
		});
		await env.BUCKET.delete([key, stateKey]);
		return;
	}

	const transcript = await step("transcript", async () =>
		isText
			? (await obj.text()).trim()
			: isPhoto
				? await readImage(env, await read(), contentType, (await (await env.BUCKET.get(captionKey(key)))?.text()) ?? "", lastAttempt)
				: await transcribe(env, await read(), contentType),
	);
	const meta = await step("meta", () => summarize(env, transcript, recordedAt, lastAttempt));

	// Тиша, шум або голосове «скасуй»: нічого не публікуємо, прибираємо все, включно з оригіналом у каналі.
	if (meta.discard) {
		console.log(`${key} discarded: ${meta.discard}`);
		await deleteOriginal(env, obj.customMetadata);
		await env.BUCKET.delete([key, stateKey, captionKey(key)]);
		return;
	}

	// Команди налаштування Todoist («створи проєкт…») — до тріажу, щоб задачі вже бачили новий проєкт.
	const setup = await runSetup(env, transcript, state, save, lastAttempt);

	// Тріаж задач для Todoist. Невдалий тріаж не блокує нотатку: вона прийде без кнопки.
	const triaged = await step("triage", async () => {
		const snap = meta.tasks.length ? await todoistSnapshot(env) : null;
		return snap ? await triage(env, transcript, meta.tasks, snap, new Date(recordedTs(key)), env.TIMEZONE) : null;
	});
	const noteId = await step("noteId", async () => crypto.randomUUID());
	// "" — нових задач немає, робити в Todoist нічого.
	const actionId = await step("actionId", async () => {
		const newTasks = triaged?.filter((i) => !i.duplicateOf) ?? [];
		if (!newTasks.length) return "";
		const ops: TodoistOp[] = newTasks.map((item) => ({ key: item.key ?? "", item }));
		const id = await createAction(env, ops, `🎙 ${meta.title} (${recordedAt})`, noteId);
		console.log(`todoist action ${id}: ${newTasks.length} new, ${triaged!.length - newTasks.length} duplicates`);
		return id;
	});

	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	const messageId = await step("messageId", async () => {
		const max = isText ? TEXT_CAPTION_MAX : CAPTION_MAX;
		const caption = buildCaption(meta, triaged, recordedTs(key), env.TIMEZONE, captionNotice(setup, false), max);
		return isText
			? await (({ text, entities }) => tgSendText(env, text, entities))(textNote(caption, transcript))
			: await tgSendNote(env, source, meta.title, caption);
	});

	// Посилання на повідомлення в описі задач Todoist (лише для каналів і супергруп).
	const messageUrl = telegramMessageUrl(env.CHAT_ID, messageId);
	if (actionId && messageUrl) {
		await step("messageLinked", async () => {
			await setActionMessage(env, actionId, messageUrl);
			return true;
		});
	}

	// Зберігаємо нотатку для редагування (повторний запис при ретраї нічого не ламає).
	const note: Note = {
		transcript,
		edits: [],
		meta,
		triage: triaged,
		actionId: actionId || undefined,
		messageId,
		recordedTs: recordedTs(key),
		...(isText && { text: true }),
		...(setup.length && { setup }),
	};
	await env.BUCKET.put(noteKey(noteId), JSON.stringify(note));
	await env.BUCKET.put(noteByMessageKey(messageId), noteId);
	console.log(`note ${noteId} published as message ${messageId}`);

	if (actionId) {
		// Задачі одразу в Todoist (посилання на повідомлення вже в описі), потім назви задач у підписі стають посиланнями на них.
		const applied = await step("todoistApplied", () => applyOnce(env, actionId), { onFinalFailure: () => false });
		await step("todoistMarked", async () => {
			await markInTodoist(env, noteId, !applied);
			return true;
		});
		// Фото — коментарем-вкладенням до кожної створеної задачі. Збій на останній спробі не блокує нотатку.
		if (isPhoto && applied) {
			await step(
				"photoAttached",
				async () => {
					const ids = Object.values(await getInTodoist(env, noteId)).map((t) => t.id);
					await attachFile(env, actionId, ids, await source.blob(), `${meta.title.slice(0, 60) || "photo"}.jpg`);
					console.log(`photo attached to ${ids.length} tasks`);
					return true;
				},
				{ onFinalFailure: () => true },
			);
		}
	}

	// Голосове, надіслане в канал, видаляємо: нотатка вище містить те саме аудіо.
	await step("originalDeleted", async () => {
		await deleteOriginal(env, obj.customMetadata);
		return true;
	});

	await env.BUCKET.delete([key, stateKey, captionKey(key)]);
}

// ---------- Редагування нотатки голосовою інструкцією ----------
// Поки нотатка редагується, на ній стоїть 👨‍💻 (✏ серед реакцій для ботів немає).
const markEditing = (env: Env, messageId: number, on: boolean) =>
	tg(env, "setMessageReaction", {
		chat_id: env.CHAT_ID,
		message_id: messageId,
		reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [],
	}).catch((err) => console.error("reaction failed:", err));

async function processEdit(env: Env, key: string, noteId: string, lastAttempt: boolean): Promise<void> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return; // уже оброблено
	const stateKey = `${key}.state.json`;
	const cleanup = async (messageId?: number) => {
		if (messageId) await markEditing(env, messageId, false);
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
		await markEditing(env, note.messageId, true);
		// Текстова відповідь на нотатку — без Whisper.
		const contentType = obj.httpMetadata?.contentType ?? "audio/mp4";
		state.transcript = contentType.startsWith("text/")
			? (await obj.text()).trim()
			: await transcribe(env, await obj.arrayBuffer(), contentType);
		await save();
	}
	const instruction = state.transcript;
	// Команди налаштування Todoist — до правки, щоб модель уже бачила нові назви проєктів і міток.
	const setup = await runSetup(env, instruction, state, save, lastAttempt);
	if (state.meta === undefined) {
		const snap = await todoistSnapshot(env);
		const edited = instruction ? await editNote(env, note, instruction, snap) : null;
		if (instruction && !edited && !lastAttempt) throw new Error("All edit models failed");
		// Інструкція була лише командою налаштування: нотатку лишаємо, але підпис оновимо (звіт про зміни).
		const keepNote = setup.length > 0 && (!edited || (edited.meta.discard && edited.meta.discard !== "delete"));
		// Порожня інструкція або (на останній спробі) збій моделей: нотатку лишаємо як є.
		state.meta = keepNote ? note.meta : (edited?.meta ?? { title: "", summary: "", ideas: [], tasks: [], discard: "empty" });
		state.triage = keepNote ? note.triage : (edited?.triage ?? null);
		await save();
	}
	const meta = state.meta;
	if (meta.discard === "delete") {
		// «Видали нотатку»: відкриті задачі в Todoist, саму нотатку в каналі й записи в R2.
		const ids = Object.values(await getInTodoist(env, noteId)).map((t) => t.id);
		const deleted = env.TODOIST_TOKEN ? await deleteOpenTasks(env, ids) : 0;
		await tg(env, "deleteMessage", { chat_id: env.CHAT_ID, message_id: note.messageId }).catch((err) =>
			console.error("delete note message failed:", err),
		);
		if (note.actionId) await deleteAction(env, note.actionId);
		await env.BUCKET.delete([noteKey(noteId), noteByMessageKey(note.messageId), `notes/${noteId}.todoist.json`]);
		console.log(`note ${noteId} deleted by request: ${deleted} open tasks deleted in Todoist`);
		await cleanup();
		return;
	}
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
			const n = (f: (op: TodoistOp) => boolean) => ops.filter(f).length;
			console.log(
				`todoist action ${state.actionId}: ${n((o) => !o.id)} create, ${n((o) => !!o.id && !!o.item)} update, ${n((o) => !o.item)} delete`,
			);
		} else {
			state.actionId = "";
		}
		await save();
	}

	if (state.actionId && state.todoistApplied === undefined) {
		state.todoistApplied = await applyNow(env, state.actionId, lastAttempt);
		await save();
	}

	const allSetup = [...(note.setup ?? []), ...setup];
	if (!state.captionEdited) {
		const notice = captionNotice(allSetup, state.todoistApplied === false);
		await editNoteMessage(env, note, ...(await appliedCaption(env, noteId, note, meta, state.triage ?? null, notice)));
		state.captionEdited = true;
		await save();
	}

	const updated: Note = {
		...note,
		edits: [...note.edits, instruction],
		meta,
		triage: state.triage ?? null,
		actionId: state.actionId || undefined,
		...(allSetup.length && { setup: allSetup }),
	};
	await env.BUCKET.put(noteKey(noteId), JSON.stringify(updated));
	// Стара дія (з часів кнопки, якщо її не натиснули) більше не актуальна.
	if (note.actionId && note.actionId !== state.actionId) await deleteAction(env, note.actionId);
	console.log(`note ${noteId} edited`);
	await cleanup(note.messageId);
}

// ---------- Todoist ----------
const TODOIST_FAILED = "⚠️ Не вдалося оновити Todoist";
const SETUP_FAILED = "⚠️ Не вдалося змінити проєкти чи мітки";

// Блок під нотаткою: зміни налаштувань Todoist і збій задач.
const captionNotice = (setup: string[] | undefined, failed: boolean) =>
	[setup?.length ? `⚙️ Todoist:\n${setup.join("\n")}` : "", failed ? TODOIST_FAILED : ""].filter(Boolean).join("\n\n");

// Команди налаштування з тексту: план зберігається в стані, виконання ідемпотентне (сталі uuid).
// Повертає рядки звіту для підпису ([] — команд не було).
async function runSetup(env: Env, text: string, state: State, save: () => Promise<unknown>, lastAttempt: boolean): Promise<string[]> {
	if (state.setup === undefined) {
		const plan = await planSetup(env, text, lastAttempt);
		state.setup = plan.changes.length ? { id: crypto.randomUUID(), plan } : null;
		await save();
	}
	const s = state.setup;
	if (!s) return [];
	if (s.ok === undefined) {
		try {
			await applySetup(env, s.id, s.plan);
			s.ok = true;
		} catch (err) {
			if (!lastAttempt) throw err;
			console.error(`todoist setup ${s.id} failed:`, err);
			s.ok = false;
		}
		console.log(`todoist setup ${s.id}: ${s.plan.changes.length} changes, ${s.ok ? "applied" : "failed"}`);
		await save();
	}
	return s.ok ? setupReport(s.plan) : [SETUP_FAILED];
}
const NO_BUTTONS = { inline_keyboard: [] }; // прибирає кнопку (у старих нотатках)

// Виконує дію в Todoist одразу. Збій — ретрай черги (сталі uuid не дадуть дублів);
// на останній спробі повертає false, щоб нотатка все одно дійшла.
async function applyOnce(env: Env, actionId: string): Promise<true> {
	const res = await applyAction(env, actionId);
	if (res.status === "applied") console.log(`todoist action ${actionId} applied: ${res.count} ops`);
	return true;
}

async function applyNow(env: Env, actionId: string, lastAttempt: boolean): Promise<boolean> {
	try {
		return await applyOnce(env, actionId);
	} catch (err) {
		if (!lastAttempt) throw err;
		console.error(`todoist action ${actionId} failed:`, err);
		return false;
	}
}

// Кнопка «Додати в Todoist» лишилась лише в нотатках, опублікованих до автододавання.
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

// Після виконання дії: назви задач, що вже в Todoist, — посилання на них; кнопки прибираються.
async function markInTodoist(env: Env, noteId: string, failed = false): Promise<void> {
	const note = await (await env.BUCKET.get(noteKey(noteId)))?.json<Note>();
	if (!note) return;
	const notice = captionNotice(note.setup, failed);
	await editNoteMessage(env, note, ...(await appliedCaption(env, noteId, note, note.meta, note.triage, notice)));
}

// Підпис після виконання в Todoist: назви задач — посилання, 🔁 лише в задач, де Todoist прийняв повтор.
async function appliedCaption(
	env: Env,
	noteId: string,
	note: Note,
	meta: Meta,
	triage: TriageItem[] | null,
	notice: string,
): Promise<[string, object[]]> {
	const inTodoist = await getInTodoist(env, noteId);
	const shown = withAppliedRecurrence(triage, inTodoist);
	const caption = buildCaption(meta, shown, note.recordedTs, env.TIMEZONE, notice, note.text ? TEXT_CAPTION_MAX : CAPTION_MAX);
	const ids = Object.fromEntries(Object.entries(inTodoist).map(([key, v]) => [key, v.id]));
	return [caption, taskLinks(caption, shown, ids)];
}

// Оновлює підпис (з посиланнями на задачі) і прибирає кнопки. Текстова нотатка — це текст повідомлення з цитатою оригіналу.
async function editNoteMessage(env: Env, note: Note, caption: string, entities: object[]): Promise<void> {
	const common = { chat_id: env.CHAT_ID, message_id: note.messageId, reply_markup: NO_BUTTONS };
	await (
		note.text
			? tg(env, "editMessageText", { ...common, ...textNote(caption, note.transcript, entities), link_preview_options: NO_PREVIEW })
			: tg(env, "editMessageCaption", { ...common, caption, caption_entities: entities })
	).catch(
		(err) => {
			if (!String(err).includes("message is not modified")) throw err;
		},
	);
}

// Видаляє оригінальне голосове з каналу (якщо запис прийшов звідти). Збій не критичний.
async function deleteOriginal(env: Env, meta: Record<string, string> | undefined): Promise<void> {
	const { deleteChatId, deleteMessageId } = meta ?? {};
	if (!deleteChatId || !deleteMessageId) return;
	await tg(env, "deleteMessage", { chat_id: deleteChatId, message_id: Number(deleteMessageId) }).catch((err) =>
		console.error("delete original message failed:", err),
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

// ---------- Фото: текст на зображенні й опис (vision), далі — як текстова нотатка ----------
const IMAGE_SYSTEM = `The author sent a photo as a note, optionally with a caption. Read the image.
- text: all text visible on the image, verbatim, in its original language, keeping line breaks; "" if there is none.
- description: 1–2 sentences in Ukrainian on what the image shows (e.g. receipt, screenshot of a chat, handwritten list, poster, whiteboard), without repeating the text.`;

async function readImage(env: Env, image: ArrayBuffer, type: string, caption: string, lastAttempt: boolean): Promise<string> {
	const schema = {
		type: "object",
		properties: { text: { type: "string" }, description: { type: "string" } },
		required: ["text", "description"],
		additionalProperties: false,
	};
	const res = await askJson(
		env,
		{ name: "image_note", system: IMAGE_SYSTEM, user: caption ? `Caption: ${caption}` : "No caption.", schema, image: { base64: toBase64(image), type } },
		(t) => {
			const j = parseJsonObject(t);
			return { text: String(j.text ?? "").trim(), description: String(j.description ?? "").trim() };
		},
	);
	if (!res && !lastAttempt) throw new Error("All image models failed");
	return [
		caption && `Підпис автора: ${caption}`,
		res?.description && `Що на фото: ${res.description}`,
		res?.text && `Текст на фото:\n${res.text}`,
	]
		.filter(Boolean)
		.join("\n\n");
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
- discard: normally "none". Use "empty" when the transcript has no meaningful content: silence, noise, filler, or typical speech-recognition hallucinations on silence ("Дякую за перегляд", "Субтитри зроблені…", "Продовження наступне", a single repeated word). Use "cancelled" when the author explicitly asks to cancel, discard or not save this whole recording ("скасуй", "відміна, не зберігай", "видали цей запис", "забудь, не надсилай"), usually at the end. A cancel phrase that is about a real-world thing ("скасувати зустріч", "відмінити підписку") is a task, not "cancelled". When discard is not "none", the other fields may be empty.
- Commands that change the Todoist setup (create, rename or delete a project or a label, change its description: "створи проєкт Спорт", "видали мітку Office") are carried out automatically: never list them as tasks, mention them briefly in the summary, and never discard such a note as "empty".`;

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
Keep the summary and ideas consistent with the edited note: if the instruction changes something they mention (a date, a removed task), update that part, otherwise leave them as is.
Removing a property of a task ("прибери повтор", "зроби разовою", "без дати", "прибери нагадування", "зніми мітку") keeps the task and clears only that field (removing a recurrence keeps due as the next occurrence, so the task stays a one-time task on that date); remove a task only when the instruction asks to remove the task itself.
Change a task's title only when the instruction asks to rename or reword it. Moving a task in time ("перенеси на п'ятницю", "зроби на сьогодні") changes only due/deadline and never turns into a title like "Перенести …".
${EDIT_TASKS_HELP}
Commands in the instruction that change the Todoist setup (create, rename or delete a project or a label, change its description) are carried out separately and are already applied: never turn them into tasks; if the instruction has nothing else, return the note unchanged with discard "none". If a task's project or label was renamed, use the new name from <projects> / <labels>.
Relative dates in the instruction ("сьогодні", "завтра", "в п'ятницю") are counted from the edit date; in the original transcript, from the recording date.
In editing mode, discard means: "delete" if the author asks to delete the whole note ("видали нотатку", "видали цей запис повністю", "видали все") — not when they ask to remove one or some tasks, that is a normal edit; "cancelled" if the author cancels this edit itself ("скасуй", "нічого не міняй"); "empty" if the instruction has no meaningful content; otherwise "none".`;

async function editNote(
	env: Env,
	note: Note,
	instruction: string,
	snap: TodoistSnapshot | null,
): Promise<{ meta: Meta; triage: TriageItem[] | null } | null> {
	const { title, summary, ideas } = note.meta;
	const oldTasks = note.triage ?? plainTasks(note.meta.tasks);
	const tasks = oldTasks.map(({ key, title, project, labels, priority, due, deadline, recurrence, recurrenceLabel, reminders, details, duplicateOf }) =>
		snap
			? {
					key,
					title,
					project,
					labels,
					priority: `p${priority}`,
					due,
					deadline,
					recurrence: recurrence ?? "",
					recurrence_label: recurrenceLabel ?? "",
					// у форматі для моделі: "before 60" або "2026-11-11 09:00"
					reminders: (reminders ?? []).map((r) => (r.startsWith("before:") ? r.replace(":", " ") : r.replace("T", " "))),
					details: details ?? "",
					...(duplicateOf && { already_exists_as: duplicateOf }),
				}
			: { key, title },
	);
	const taskSchema = {
		type: "object",
		properties: { key: { type: "string" }, title: { type: "string" }, ...(snap ? taskFieldsSchema(snap) : {}) },
		required: snap
			? ["key", "title", "project", "labels", "priority", "due", "deadline", "recurrence", "recurrence_label", "reminders", "details"]
			: ["key", "title"],
		additionalProperties: false,
	};
	const schema = {
		...SUMMARY_SCHEMA,
		properties: {
			...SUMMARY_SCHEMA.properties,
			tasks: { type: "array", items: taskSchema },
			discard: { type: "string", enum: ["none", "empty", "cancelled", "delete"] },
		},
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
