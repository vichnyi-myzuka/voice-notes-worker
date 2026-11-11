import type { Env, Job } from "../../infrastructure/env";
import { processEdit, processNote } from "../../application/pipeline";
import { loadNote } from "../../domain/published";
import type { Channel } from "../../domain/channel";

export async function handleQueue(batch: MessageBatch<Job>, env: Env, channel: Channel): Promise<void> {
	if (batch.queue === DLQ_NAME) {
		for (const msg of batch.messages) {
			// Правка не вдалася: знімаємо з нотатки статус «редагується».
			const note = msg.body.edit && (await loadNote(env, msg.body.edit));
			if (note) await channel.setBusy(note.messageId, false);
			await channel.say(
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
			if (msg.body.edit) await processEdit(env, channel, msg.body.key, msg.body.edit, last);
			else await processNote(env, channel, msg.body.key, last);
			msg.ack();
		} catch (err) {
			console.error(`attempt ${msg.attempts} failed for ${msg.body.key}:`, err);
			throw err; // -> retry, після max_retries -> DLQ
		}
	}
}

export const DLQ_NAME = "voice-notes-dlq";

export const MAX_RETRIES = 4; // той самий, що max_retries у wrangler.toml
