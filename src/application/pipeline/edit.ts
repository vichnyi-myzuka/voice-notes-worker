import type { Env } from "../../infrastructure/env";
import { captionNotice, loadNote, removeNote, saveNote, showNote, type Note } from "../../domain/published";
import { formatRecordedAt } from "../../domain/recording";
import { runSetup } from "../setup";
import { openSteps } from "../../infrastructure/steps";
import { deleteOpenTasks, getInTodoist, syncTasks } from "../tasks";
import { deleteOriginal, markEditing, telegramMessageUrl, tg, tgSendMessage } from "../../infrastructure/telegram";
import { trySnapshot } from "../../infrastructure/todoist";
import { editNote, transcribe } from "../understand";
import type { State } from "./types";

export async function processEdit(env: Env, key: string, noteId: string, lastAttempt: boolean): Promise<void> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return; // уже оброблено
	const stateKey = `${key}.state.json`;
	const cleanup = async (messageId?: number) => {
		if (messageId) await markEditing(env, messageId, false);
		await deleteOriginal(env, obj.customMetadata); // інструкцію з каналу прибираємо
		await env.BUCKET.delete([key, stateKey]);
	};
	const run = await openSteps<State>(env, stateKey, lastAttempt);
	const { state, step } = run;

	const note = await loadNote(env, noteId);
	if (!note) {
		await tgSendMessage(env, env.CHAT_ID, "⚠️ Не вдалося відредагувати: нотатку не знайдено (редагувати можна протягом 7 днів).");
		await cleanup();
		return;
	}

	const instruction = await step("transcript", async () => {
		await markEditing(env, note.messageId, true);
		// Текстова відповідь на нотатку — без Whisper.
		const contentType = obj.httpMetadata?.contentType ?? "audio/mp4";
		return contentType.startsWith("text/") ? (await obj.text()).trim() : await transcribe(env, await obj.arrayBuffer(), contentType);
	});
	// Команди налаштування Todoist — до правки, щоб модель уже бачила нові назви проєктів і міток.
	const setup = await runSetup(env, instruction, run);
	// Крок зберігає meta і triage разом: triage пишемо в стан до збереження кроку.
	const meta = await step("meta", async () => {
		const snap = await trySnapshot(env);
		const edited = instruction ? await editNote(env, note, instruction, snap) : null;
		if (instruction && !edited && !lastAttempt) throw new Error("All edit models failed");
		// Інструкція була лише командою налаштування: нотатку лишаємо, але підпис оновимо (звіт про зміни).
		const keepNote = setup.length > 0 && (!edited || (edited.meta.discard && edited.meta.discard !== "delete"));
		// Порожня інструкція або (на останній спробі) збій моделей: нотатку лишаємо як є.
		state.triage = keepNote ? note.triage : (edited?.triage ?? null);
		return keepNote ? note.meta : (edited?.meta ?? { title: "", summary: "", ideas: [], tasks: [], discard: "empty" });
	});
	const triaged = state.triage ?? null;
	if (meta.discard === "delete") {
		// «Видали нотатку»: відкриті задачі в Todoist, саму нотатку в каналі й записи в R2.
		const ids = Object.values(await getInTodoist(env, noteId)).map((t) => t.id);
		const deleted = env.TODOIST_TOKEN ? await deleteOpenTasks(env, ids) : 0;
		await tg(env, "deleteMessage", { chat_id: env.CHAT_ID, message_id: note.messageId }).catch((err) =>
			console.error("delete note message failed:", err),
		);
		await removeNote(env, noteId, note);
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
	const applied = await syncTasks(env, run, {
		noteId,
		items: triaged,
		description: `🎙 ${meta.title} (${formatRecordedAt(String(note.recordedTs), env.TIMEZONE)})`,
		messageUrl: telegramMessageUrl(env.CHAT_ID, note.messageId),
	});

	const allSetup = [...(note.setup ?? []), ...setup];
	await step("captionEdited", async () => {
		const notice = captionNotice(allSetup, applied === false);
		await showNote(env, noteId, note, { meta, triage: triaged, notice });
		return true;
	});

	const updated: Note = {
		...note,
		edits: [...note.edits, instruction],
		meta,
		triage: triaged,
		...(allSetup.length && { setup: allSetup }),
	};
	await saveNote(env, noteId, updated);
	console.log(`note ${noteId} edited`);
	await cleanup(note.messageId);
}
