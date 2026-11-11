import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { fakeEnv } from "./fake-env";

// Node-vitest не має crypto.subtle.timingSafeEqual: для вебхука підміняємо порівняння секретів.
vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

// Наскрізний прогін через справжню точку входу (worker.fetch → черга → worker.queue):
// вебхук каналу → запис у R2 і чергу → обробка → публікація в Telegram → задача в Todoist → правка «Видали нотатку».
// Зовнішні сервіси (OpenAI, Telegram, Todoist) підмінено в одному місці — fetch.

const CHAT_ID = "-1004390223227";
const NOTE_MESSAGE_ID = 777;

const summary = { title: "Купити хліб", summary: "Треба купити хліб.", ideas: [], tasks: ["Купити хліб"], discard: "none" };
const triageItem = {
	quote: "купити хліб",
	title: "Купити хліб",
	duplicate_of: "",
	project: "",
	labels: [],
	priority: "p2",
	due: "",
	deadline: "",
	recurrence: "",
	recurrence_label: "",
	reminders: [],
	details: "",
};

type Command = { type: string; uuid: string; temp_id?: string; args: Record<string, unknown> };

// Мережа: що відповідає кожен сервіс і що йому надсилали.
function stubServices() {
	const telegram: { method: string; body: Record<string, unknown> }[] = [];
	const todoist: Command[] = [];
	const openTasks = new Set<string>();
	let llmReply: (name: string) => object = () => ({});

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { body?: unknown }) => {
			if (url.includes("api.openai.com")) {
				const name = JSON.parse(String(init?.body)).text.format.name as string;
				const text = JSON.stringify(llmReply(name));
				return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
			}
			if (url.includes("api.telegram.org")) {
				const method = url.split("/").pop()!;
				telegram.push({ method, body: JSON.parse(String(init?.body)) });
				return Response.json({ result: method === "sendMessage" ? { message_id: NOTE_MESSAGE_ID } : true });
			}
			if (url.includes("todoist.com/api/v1/projects/archived")) return Response.json({ results: [], next_cursor: null });
			if (url.includes("todoist.com/api/v1/sync")) {
				const form = init?.body as URLSearchParams;
				if (form.get("commands")) {
					const commands = JSON.parse(form.get("commands")!) as Command[];
					todoist.push(...commands);
					const mapping: Record<string, string> = {};
					for (const c of commands) {
						if (c.type === "item_add" && c.temp_id) openTasks.add((mapping[c.temp_id] = `task-${openTasks.size + 1}`));
						if (c.type === "item_delete") openTasks.delete(String(c.args.id));
					}
					return Response.json({ sync_status: Object.fromEntries(commands.map((c) => [c.uuid, "ok"])), temp_id_mapping: mapping });
				}
				return Response.json({
					projects: [{ id: "inbox-id", name: "Inbox", inbox_project: true }],
					labels: [],
					items: [...openTasks].map((id) => ({ id, content: "Купити хліб" })),
				});
			}
			throw new Error(`unexpected request: ${url}`);
		}),
	);
	return {
		telegram,
		todoist,
		openTasks,
		reply: (fn: (name: string) => object) => (llmReply = fn),
	};
}

function makeEnv() {
	const jobs: { key: string; edit?: string }[] = [];
	const env = {
		...fakeEnv({ OPENAI_KEY: "k", BOT_TOKEN: "t", CHAT_ID, TG_WEBHOOK_SECRET: "wh", TODOIST_TOKEN: "td" }),
		QUEUE: { send: vi.fn(async (job: { key: string; edit?: string }) => void jobs.push(job)) } as unknown as Queue,
	};
	return { env, jobs };
}

const webhook = (message: object) =>
	new Request("https://worker/telegram", {
		method: "POST",
		headers: { "x-telegram-bot-api-secret-token": "wh", "content-type": "application/json" },
		body: JSON.stringify({ channel_post: { chat: { id: Number(CHAT_ID), type: "channel" }, date: 1762700000, ...message } }),
	});

async function drain(env: ReturnType<typeof makeEnv>["env"], jobs: { key: string; edit?: string }[]) {
	const ack = vi.fn();
	const job = jobs.shift()!;
	await worker.queue!({ queue: "voice-notes", messages: [{ body: job, attempts: 1, ack }] } as never, env);
	expect(ack).toHaveBeenCalled();
}

beforeEach(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("e2e: пост у каналі → нотатка + задача → «Видали нотатку»", () => {
	it("повний цикл", async () => {
		const net = stubServices();
		net.reply((name) => (name === "voice_note" ? summary : name === "todoist_triage" ? { items: [triageItem] } : {}));
		const { env, jobs } = makeEnv();

		// 1. Вебхук: текст у каналі → запис у R2 і в чергу, ✍ на повідомленні.
		const res = await worker.fetch!(webhook({ message_id: 5, text: "Купити хліб" }) as never, env);
		expect(res.status).toBe(200);
		expect(jobs).toHaveLength(1);
		expect(jobs[0].edit).toBeUndefined();
		expect(net.telegram.map((c) => c.method)).toContain("setMessageReaction");

		// 2. Обробка черги: нотатка опублікована, задача створена, підпис оновлено посиланням на задачу.
		await drain(env, jobs);
		const sent = net.telegram.find((c) => c.method === "sendMessage")!;
		expect(sent.body.text).toContain("Купити хліб");
		expect(net.todoist.filter((c) => c.type === "item_add")).toHaveLength(1);
		expect(net.todoist.find((c) => c.type === "item_add")!.args).toMatchObject({ content: "Купити хліб", priority: 3 });
		const edited = net.telegram.find((c) => c.method === "editMessageText")!;
		expect(JSON.stringify(edited.body.entities)).toContain("task/task-1");
		expect(net.telegram.map((c) => c.method)).toContain("deleteMessage"); // оригінал у каналі прибрано
		expect([...env.store.keys()].filter((k) => k.startsWith("notes/")).sort()).toEqual([
			expect.stringMatching(/^notes\/[0-9a-f-]+\.json$/),
			expect.stringMatching(/^notes\/[0-9a-f-]+\.tasks\.json$/),
			`notes/msg-${NOTE_MESSAGE_ID}`,
		]);
		expect([...env.store.keys()].some((k) => k.endsWith(".txt") || k.endsWith(".state.json"))).toBe(false);

		// 3. Відповідь «Видали нотатку»: правка ставиться в чергу з id нотатки.
		net.telegram.length = 0;
		await worker.fetch!(webhook({ message_id: 6, text: "Видали нотатку", reply_to_message: { message_id: NOTE_MESSAGE_ID } }) as never, env);
		expect(jobs).toHaveLength(1);
		expect(jobs[0].edit).toBeTruthy();
		expect(net.telegram.some((c) => c.method === "setMessageReaction" && c.body.message_id === NOTE_MESSAGE_ID)).toBe(true); // нотатка позначена «редагується»

		// 4. Обробка правки: задача й нотатка видалені, у R2 нічого не лишається.
		net.reply((name) => (name === "voice_note_edit" ? { ...summary, tasks: [], discard: "delete" } : {}));
		await drain(env, jobs);
		expect(net.todoist.some((c) => c.type === "item_delete")).toBe(true);
		expect(net.openTasks.size).toBe(0);
		expect(net.telegram.filter((c) => c.method === "deleteMessage").some((c) => c.body.message_id === NOTE_MESSAGE_ID)).toBe(true);
		expect([...env.store.keys()]).toEqual([]);
	});

	it("вебхук з чужим секретом відхиляється й нічого не ставить у чергу", async () => {
		stubServices();
		const { env, jobs } = makeEnv();
		const req = new Request("https://worker/telegram", {
			method: "POST",
			headers: { "x-telegram-bot-api-secret-token": "wrong" },
			body: "{}",
		});
		expect((await worker.fetch!(req as never, env)).status).toBe(401);
		expect(jobs).toHaveLength(0);
	});
});
