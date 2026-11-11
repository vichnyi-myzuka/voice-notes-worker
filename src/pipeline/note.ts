import type { Env } from "../env";
import { CAPTION_MAX, TEXT_CAPTION_MAX, buildCaption, textNote } from "../note";
import { captionNotice, refreshNote, saveNote, type Note } from "../published";
import { TELEGRAM_MAX_BYTES, TRANSCRIBE_MAX_BYTES, captionKey, formatRecordedAt, recordedTs } from "../recording";
import { runSetup } from "../setup";
import { openSteps } from "../steps";
import { attachFile, getInTodoist, syncTasks } from "../tasks";
import { deleteOriginal, telegramMessageUrl, tgSendMessage, tgSendNote, tgSendText } from "../telegram";
import { triage, trySnapshot } from "../todoist";
import { readImage, summarize, transcribe } from "../understand";
import type { State } from "./types";

export async function processNote(env: Env, key: string, lastAttempt: boolean): Promise<void> {
	const obj = await env.BUCKET.get(key);
	if (!obj) {
		// Аудіо видаляється лише після успішної відправки, тож це повторна доставка.
		console.log(`${key} not found, already processed`);
		return;
	}

	const stateKey = `${key}.state.json`;
	const run = await openSteps<State>(env, stateKey, lastAttempt);
	const { step } = run;
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
	const setup = await runSetup(env, transcript, run);

	// Тріаж задач для Todoist. Невдалий тріаж не блокує нотатку: вона прийде без кнопки.
	const triaged = await step("triage", async () => {
		const snap = meta.tasks.length ? await trySnapshot(env) : null;
		return snap ? await triage(env, transcript, meta.tasks, snap, new Date(recordedTs(key)), env.TIMEZONE) : null;
	});
	const noteId = await step("noteId", async () => crypto.randomUUID());
	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	const messageId = await step("messageId", async () => {
		const max = isText ? TEXT_CAPTION_MAX : CAPTION_MAX;
		const caption = buildCaption(meta, triaged, recordedTs(key), env.TIMEZONE, captionNotice(setup, false), max);
		return isText
			? await (({ text, entities }) => tgSendText(env, text, entities))(textNote(caption, transcript))
			: await tgSendNote(env, source, meta.title, caption);
	});

	// Зберігаємо нотатку для редагування (повторний запис при ретраї нічого не ламає).
	const note: Note = {
		transcript,
		edits: [],
		meta,
		triage: triaged,
		messageId,
		recordedTs: recordedTs(key),
		...(isText && { text: true }),
		...(setup.length && { setup }),
	};
	await saveNote(env, noteId, note);
	console.log(`note ${noteId} published as message ${messageId}`);

	// Задачі одразу в Todoist (з посиланням на повідомлення в описі), потім назви задач у підписі стають посиланнями на них.
	const applied = await syncTasks(env, run, {
		noteId,
		items: triaged,
		description: `🎙 ${meta.title} (${recordedAt})`,
		messageUrl: telegramMessageUrl(env.CHAT_ID, messageId),
	});
	if (applied !== undefined) {
		await step("todoistMarked", async () => {
			await refreshNote(env, noteId, !applied);
			return true;
		});
		// Фото — коментарем-вкладенням до кожної створеної задачі. Збій на останній спробі не блокує нотатку.
		if (isPhoto && applied) {
			await step(
				"photoAttached",
				async () => {
					const ids = Object.values(await getInTodoist(env, noteId)).map((t) => t.id);
					await attachFile(env, run.state.actionId!, ids, await source.blob(), `${meta.title.slice(0, 60) || "photo"}.jpg`);
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
