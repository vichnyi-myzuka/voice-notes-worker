import type { TaskTracker } from "../../domain/tracker";
import type { Env } from "../env";
import { fetchWorld, trySnapshot } from "./api";
import { taskFieldsSchema, taskRulesBlock, taskValidator } from "./fields";
import { EDIT_TASKS_HELP, triage } from "./triage";
import { applyOps, applySetup, attachFile, deleteOpenTasks } from "./write";

// Посилання на задачу в Todoist (веб і застосунки).
export const taskUrl = (id: string) => `https://app.todoist.com/app/task/${id}`;

// Адаптер TaskTracker для Todoist.
export function todoistTracker(env: Env): TaskTracker {
	return {
		enabled: !!env.TODOIST_TOKEN,
		snapshot: () => trySnapshot(env),
		triage: (transcript, tasks, snap, recordedAt) => triage(env, transcript, tasks, snap, recordedAt, env.TIMEZONE),
		prompts: {
			help: EDIT_TASKS_HELP,
			rulesBlock: taskRulesBlock,
			fieldsSchema: taskFieldsSchema,
			validator: (snap, base) => taskValidator(snap, base, env.TIMEZONE),
		},
		applyOps: (runId, ops, description) => applyOps(env, runId, ops, description),
		attachFile: (runId, taskIds, file, fileName) => attachFile(env, runId, taskIds, file, fileName),
		deleteOpenTasks: (ids) => deleteOpenTasks(env, ids),
		taskUrl,
		world: () => fetchWorld(env),
		applySetup: (id, plan) => applySetup(env, id, plan),
	};
}
