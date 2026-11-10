import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { fakeEnv } from "./fake-env";

const KEY = "1762700000000-abcd1234.m4a";
const summary = { title: "Тестова нотатка", summary: "Коротко про тест.", ideas: [], tasks: [] };

// Підміна мережі: OpenAI (summary) і Telegram. telegramFails — скільки перших викликів failMethod мають впасти.
function stubNetwork(telegramFails = 0, failMethod = "sendMessage", reply: object = summary) {
	const calls: string[] = [];
	let fails = telegramFails;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const method = url.includes("api.telegram.org") ? url.split("/").pop()! : "openai";
			calls.push(method);
			if (method === "openai") {
				const text = JSON.stringify(reply);
				return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
			}
			if (method === failMethod && fails-- > 0) return new Response("boom", { status: 500 });
			return Response.json({ result: { message_id: 42 } });
		}),
	);
	return calls;
}

async function runQueue(env: ReturnType<typeof fakeEnv>, attempts: number, edit?: string) {
	const ack = vi.fn();
	await worker.queue!({ queue: "voice-notes", messages: [{ body: edit ? { key: KEY, edit } : { key: KEY }, attempts, ack }] } as never, env);
	return ack;
}

const textNote = (env: ReturnType<typeof fakeEnv>) =>
	env.BUCKET.put(KEY, "Це тестовий текст нотатки.", { httpMetadata: { contentType: "text/plain" }, customMetadata: {} });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("processNote", () => {
	it("публікує текстову нотатку й прибирає запис та стан", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const calls = stubNetwork();
		const env = fakeEnv({ OPENAI_KEY: "k", BOT_TOKEN: "t" });
		await textNote(env);

		const ack = await runQueue(env, 1);

		expect(ack).toHaveBeenCalled();
		expect(calls).toEqual(["openai", "sendMessage"]);
		expect([...env.store.keys()].filter((k) => k.startsWith("notes/"))).toHaveLength(2); // нотатка + notes/msg-42
		expect(env.store.has(KEY)).toBe(false);
		expect(env.store.has(`${KEY}.state.json`)).toBe(false);
	});

	it("після збою Telegram повтор не платить за LLM ще раз і не дублює публікацію", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = stubNetwork(1);
		const env = fakeEnv({ OPENAI_KEY: "k", BOT_TOKEN: "t" });
		await textNote(env);

		await expect(runQueue(env, 1)).rejects.toThrow("Telegram sendMessage 500");
		expect(JSON.parse(env.store.get(`${KEY}.state.json`)!)).toMatchObject({ transcript: "Це тестовий текст нотатки.", meta: summary });

		await runQueue(env, 2);

		expect(calls.filter((c) => c === "openai")).toHaveLength(1);
		expect(calls.filter((c) => c === "sendMessage")).toHaveLength(2); // перша невдала + одна успішна
		expect(env.store.has(`${KEY}.state.json`)).toBe(false);
	});
});

describe("processEdit", () => {
	it("після збою Telegram повтор не викликає LLM ще раз і зберігає правку", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const edited = { ...summary, title: "Нова назва" };
		const calls = stubNetwork(1, "editMessageText", edited);
		const env = fakeEnv({ OPENAI_KEY: "k", BOT_TOKEN: "t" });
		const note = { transcript: "Оригінал.", edits: [], meta: summary, triage: null, messageId: 42, recordedTs: 1762700000000, text: true };
		await env.BUCKET.put("notes/n1.json", JSON.stringify(note));
		await textNote(env);

		await expect(runQueue(env, 1, "n1")).rejects.toThrow("Telegram editMessageText 500");
		await runQueue(env, 2, "n1");

		expect(calls.filter((c) => c === "openai")).toHaveLength(1);
		const saved = JSON.parse(env.store.get("notes/n1.json")!);
		expect(saved.meta.title).toBe("Нова назва");
		expect(saved.edits).toEqual(["Це тестовий текст нотатки."]);
		expect(env.store.has(KEY)).toBe(false);
	});
});
