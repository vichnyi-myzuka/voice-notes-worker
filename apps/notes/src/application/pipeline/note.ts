import type { Env } from "../../infrastructure/env";
import { buildCaption } from "../../domain/note";
import type { Note } from "../../domain/published";
import { TELEGRAM_MAX_BYTES, TRANSCRIBE_MAX_BYTES, captionKey, formatRecordedAt, recordedTs } from "../../domain/recording";
import { runSetup } from "../setup";
import { openSteps } from "../../infrastructure/steps";
import { syncTasks } from "../tasks";
import { readImage, summarize } from "../understand";
import { captionNotice, refreshNote } from "./show";
import type { Ports, State } from "./types";

export async function processNote(env: Env, ports: Ports, key: string, lastAttempt: boolean): Promise<void> {
	const { channel, tracker, notes, ledger, llm } = ports;
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
	const source = { blob: async () => new Blob([await read()], { type: contentType }), metadata: obj.customMetadata };

	// Задовгий для транскрипції в межах 15 хв: не ретраїмо, шлемо оригінал без транскрипту.
	if (obj.size > TRANSCRIBE_MAX_BYTES) {
		await step("audioSent", async () => {
			const mb = (obj.size / 1_000_000).toFixed(1);
			if (obj.size > TELEGRAM_MAX_BYTES) {
				await channel.say(
					`🎙 Запис ${recordedAt} (${mb} МБ) завеликий і для транскрипції (ліміт 25 МБ), і для Telegram-бота (50 МБ).\n` +
						`Ключ: ${key}. Файл лишається в R2 до 7 днів.`,
				);
			} else {
				await channel.publishRecording(
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
				? await readImage(llm, await read(), contentType, (await (await env.BUCKET.get(captionKey(key)))?.text()) ?? "", lastAttempt)
				: await llm.transcribe(await read(), contentType),
	);
	const meta = await step("meta", () => summarize(llm, transcript, recordedAt, lastAttempt));

	// Тиша, шум або голосове «скасуй»: нічого не публікуємо, прибираємо все, включно з оригіналом у каналі.
	if (meta.discard) {
		console.log(`${key} discarded: ${meta.discard}`);
		await channel.removeOrigin(obj.customMetadata);
		await env.BUCKET.delete([key, stateKey, captionKey(key)]);
		return;
	}

	// Команди налаштування Todoist («створи проєкт…») — до тріажу, щоб задачі вже бачили новий проєкт.
	const setup = await runSetup(llm, tracker, transcript, run);

	// Тріаж задач для Todoist. Невдалий тріаж не блокує нотатку: вона прийде без кнопки.
	const triaged = await step("triage", async () => {
		const snap = meta.tasks.length ? await tracker.snapshot() : null;
		return snap ? await tracker.triage(transcript, meta.tasks, snap, new Date(recordedTs(key))) : null;
	});
	const noteId = await step("noteId", async () => crypto.randomUUID());
	// Транскрипт у Telegram не шлемо, він потрібен лише для title/summary.
	const messageId = await step("messageId", async () => {
		const max = isText ? channel.limits.textNote : channel.limits.caption;
		const caption = buildCaption(meta, triaged, recordedTs(key), env.TIMEZONE, captionNotice(setup, false), max);
		return isText ? await channel.publishText(caption, transcript) : await channel.publishRecording(source, meta.title, caption);
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
	await notes.save(noteId, note);
	console.log(`note ${noteId} published as message ${messageId}`);

	// Задачі одразу в Todoist (з посиланням на повідомлення в описі), потім назви задач у підписі стають посиланнями на них.
	const applied = await syncTasks(ports, run, {
		noteId,
		items: triaged,
		description: `🎙 ${meta.title} (${recordedAt})`,
		messageUrl: channel.linkTo(messageId),
	});
	if (applied !== undefined) {
		await step("tasksMarked", async () => {
			await refreshNote(env, ports, noteId, !applied);
			return true;
		});
		// Фото — коментарем-вкладенням до кожної створеної задачі. Збій на останній спробі не блокує нотатку.
		if (isPhoto && applied) {
			await step(
				"photoAttached",
				async () => {
					const ids = Object.values(await ledger.get(noteId)).map((t) => t.id);
					await tracker.attachFile(run.state.actionId!, ids, await source.blob(), `${meta.title.slice(0, 60) || "photo"}.jpg`);
					console.log(`photo attached to ${ids.length} tasks`);
					return true;
				},
				{ onFinalFailure: () => true },
			);
		}
	}

	// Голосове, надіслане в канал, видаляємо: нотатка вище містить те саме аудіо.
	await step("originalDeleted", async () => {
		await channel.removeOrigin(obj.customMetadata);
		return true;
	});

	await env.BUCKET.delete([key, stateKey, captionKey(key)]);
}
