import { afterEach, describe, expect, it, vi } from "vitest";
import { captionNotice, refreshNote, showNote } from "../src/application/pipeline";
import type { Note } from "../src/domain/published";
import { workersLlm } from "../src/infrastructure/llm";
import { r2Ledger, r2Notes } from "../src/infrastructure/r2";
import { telegramChannel } from "../src/infrastructure/telegram";
import { todoistTracker } from "../src/infrastructure/todoist";
import { fakeEnv } from "./fake-env";

const meta = { title: "Назва", summary: "Коротко.", ideas: [], tasks: [] };
const note = (extra: Partial<Note> = {}): Note => ({ transcript: "Оригінал.", edits: [], meta, triage: null, messageId: 42, recordedTs: 1762700000000, ...extra });

const ports = (env: Parameters<typeof telegramChannel>[0]) => ({ channel: telegramChannel(env), tracker: todoistTracker(env), notes: r2Notes(env), ledger: r2Ledger(env), llm: workersLlm(env) });

afterEach(() => vi.unstubAllGlobals());

// Записує, які методи Telegram викликано, і тіла запитів.
function stubTelegram(error?: string) {
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: { body: string }) => {
			calls.push({ method: url.split("/").pop()!, body: JSON.parse(init.body) });
			return error ? new Response(error, { status: 400 }) : Response.json({ result: true });
		}),
	);
	return calls;
}

describe("published note", () => {
	it("зберігає нотатку й знаходить її за id та за повідомленням", async () => {
		const env = fakeEnv();
		await r2Notes(env).save("n1", note());
		expect(await r2Notes(env).load("n1")).toEqual(note());
		expect(await r2Notes(env).idByMessage(42)).toBe("n1");
		expect(await r2Notes(env).idByMessage("42")).toBe("n1");
	});

	it("невідомі нотатка й повідомлення дають null", async () => {
		const env = fakeEnv();
		expect(await r2Notes(env).load("nope")).toBeNull();
		expect(await r2Notes(env).idByMessage(7)).toBeNull();
	});

	it("remove прибирає запис, ключ за повідомленням і стан задач", async () => {
		const env = fakeEnv();
		await r2Notes(env).save("n1", note());
		env.store.set("notes/n1.tasks.json", "{}");
		env.store.set("notes/n1.todoist.json", "{}");
		await r2Notes(env).remove("n1", note());
		await r2Ledger(env).remove("n1");
		expect([...env.store.keys()]).toEqual([]);
	});

	it("showNote редагує підпис аудіо-нотатки", async () => {
		const calls = stubTelegram();
		const env = fakeEnv({ BOT_TOKEN: "t" });
		await showNote(env, ports(env), "n1", note(), { meta, triage: null, notice: "" });
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("editMessageCaption");
		expect(calls[0].body).toMatchObject({ message_id: 42, caption: expect.stringContaining("Назва") });
	});

	it("showNote редагує текст текстової нотатки без прев'ю посилань", async () => {
		const calls = stubTelegram();
		const env = fakeEnv({ BOT_TOKEN: "t" });
		await showNote(env, ports(env), "n1", note({ text: true }), { meta, triage: null, notice: "" });
		expect(calls[0].method).toBe("editMessageText");
		expect(calls[0].body).toMatchObject({ link_preview_options: { is_disabled: true } });
	});

	it("«message is not modified» не є помилкою, інші помилки кидаються", async () => {
		const env = fakeEnv({ BOT_TOKEN: "t" });
		stubTelegram("Bad Request: message is not modified");
		await expect(showNote(env, ports(env), "n1", note(), { meta, triage: null, notice: "" })).resolves.toBeUndefined();
		stubTelegram("Bad Request: chat not found");
		await expect(showNote(env, ports(env), "n1", note(), { meta, triage: null, notice: "" })).rejects.toThrow("chat not found");
	});

	it("refreshNote без нотатки нічого не робить, зі збоєм Todoist додає попередження", async () => {
		const calls = stubTelegram();
		const env = fakeEnv({ BOT_TOKEN: "t" });
		await refreshNote(env, ports(env), "n1", false);
		expect(calls).toHaveLength(0);
		await r2Notes(env).save("n1", note());
		await refreshNote(env, ports(env), "n1", true);
		expect(calls[0].body.caption).toContain("Не вдалося оновити Todoist");
	});

	it("captionNotice збирає зміни налаштувань і збій", () => {
		expect(captionNotice(undefined, false)).toBe("");
		expect(captionNotice(["+ проєкт"], true)).toBe("⚙️ Todoist:\n+ проєкт\n\n⚠️ Не вдалося оновити Todoist");
	});
});
