import type { Incoming } from "@voice-notes/core";
import type { Env } from "../../infrastructure/env";
import type { Ports } from "../pipeline";
import { enqueueNote } from "./enqueue";

// Відповідь на повідомлення, що не є нашою нотаткою (або застаріла): обробка повідомить про це користувача.
const MISSING_NOTE = "missing";

// Ставить прийнятий каналом запис у чергу. Повертає true, якщо оригінал лишається (нова нотатка),
// і false, якщо його вже прибрано (правка існуючої нотатки).
export async function acceptIncoming(
	env: Env,
	{ channel, notes, recordings }: Ports,
	key: string,
	body: ArrayBuffer,
	{ contentType, caption, replyTo, metadata, origin }: Incoming,
): Promise<boolean> {
	if (caption) await recordings.putCaption(key, caption);
	// Відповідь на повідомлення в каналі = редагування цієї нотатки.
	const edit = replyTo ? (await notes.idByMessage(replyTo)) || MISSING_NOTE : undefined;
	if (!replyTo || edit === MISSING_NOTE) {
		// Нова нотатка або відповідь не на нашу: оригінал лишається в каналі (його прибере обробка).
		await enqueueNote(env, recordings, { key, body, contentType, metadata: { ...metadata, ...origin }, edit });
		return true;
	}
	// Правка: відповідь одразу прибираємо, а статус «редагується» — на самій нотатці.
	await enqueueNote(env, recordings, { key, body, contentType, metadata, edit });
	await channel.setBusy(Number(replyTo), true);
	await channel.removeOrigin(origin);
	return false;
}
