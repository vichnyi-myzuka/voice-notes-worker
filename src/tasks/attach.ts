import type { Env } from "../env";
import { sync } from "../todoist";

// Фото з нотатки — коментарем-вкладенням до задач. Повтор безпечний: коментарі мають сталі uuid
// (повторне завантаження файлу лише лишить зайвий upload).
export async function attachFile(env: Env, id: string, taskIds: string[], file: Blob, fileName: string): Promise<void> {
	if (!taskIds.length) return;
	const form = new FormData();
	form.append("file", file, fileName);
	const res = await fetch("https://api.todoist.com/api/v1/uploads", {
		method: "POST",
		headers: { authorization: `Bearer ${env.TODOIST_TOKEN}` },
		body: form,
	});
	if (!res.ok) throw new Error(`Todoist uploads ${res.status}: ${await res.text()}`);
	const upload = await res.json();
	const commands = taskIds.map((item_id, n) => ({
		type: "note_add",
		uuid: `${id}-a${n}`,
		temp_id: `tmp-${id}-a${n}`,
		args: { item_id, content: "📷 Фото з нотатки", file_attachment: upload },
	}));
	const status = ((await sync(env, { commands: JSON.stringify(commands) })) as { sync_status: Record<string, unknown> }).sync_status;
	const errors = Object.values(status).filter((s) => s !== "ok");
	if (errors.length) throw new Error(`Todoist note_add: ${JSON.stringify(errors)}`);
}
