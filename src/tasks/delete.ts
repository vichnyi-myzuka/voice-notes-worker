import type { Env } from "../env";
import { sync } from "../todoist";

// Видаляє задачі, які ще відкриті (виконані лишаються в історії Todoist). Повертає кількість видалених.
export async function deleteOpenTasks(env: Env, ids: string[]): Promise<number> {
	if (!ids.length) return 0;
	const d = (await sync(env, { sync_token: "*", resource_types: JSON.stringify(["items"]) })) as {
		items: { id: string; checked?: boolean; is_deleted?: boolean }[];
	};
	const open = new Set(d.items.filter((i) => !i.checked && !i.is_deleted).map((i) => i.id));
	const commands = ids.filter((id) => open.has(id)).map((id) => ({ type: "item_delete", uuid: `delete-${id}`, args: { id } }));
	if (!commands.length) return 0;
	const res = (await sync(env, { commands: JSON.stringify(commands) })) as { sync_status: Record<string, unknown> };
	const errors = Object.values(res.sync_status).filter((s) => s !== "ok");
	if (errors.length) throw new Error(`Todoist delete failed: ${JSON.stringify(errors)}`);
	return commands.length;
}
