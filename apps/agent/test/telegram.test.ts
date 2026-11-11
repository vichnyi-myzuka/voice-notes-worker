import { afterEach, describe, expect, it, vi } from "vitest";
import type { Llm } from "@voice-notes/core";
import type { Env } from "../src/env";
import { handleTelegram } from "../src/interface/telegram";
import { fakeAgent } from "./fake-agent";

// timingSafeEqual є лише в workerd: у Node мокаємо порівняння (мок за шляхом файлу в core).
vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

const env = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42" } as unknown as Env;
const OWNER = 42;

// Telegram Bot API на підміненому fetch: запам'ятовує виклики методів і віддає файл для getFile.
function setup(transcript = "Поправ README") {
	const agent = fakeAgent();
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
			const method = input.split("/").pop()!;
			calls.push({ method, body: JSON.parse(init!.body as string) });
			return Response.json({ ok: true, result: method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: 1 } });
		}),
	);
	const llm: Llm = { askJson: async () => null, transcribe: vi.fn(async () => transcript) };
	const pending: Promise<unknown>[] = [];
	const deps = { agent: agent.agent, llm, defer: (w: Promise<unknown>) => void pending.push(w) };
	const send = async (message: unknown, headers: HeadersInit = { "x-telegram-bot-api-secret-token": "secret" }) => {
		const res = await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers, body: JSON.stringify({ update_id: 1, message }) }), env, deps);
		await Promise.all(pending.splice(0)); // фонова робота до кінця
		return res;
	};
	const replies = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string);
	return { ...agent, llm, send, calls, replies };
}

const msg = (extra: Record<string, unknown>, id = 7) => ({ message_id: id, date: 1, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, ...extra });

afterEach(() => vi.unstubAllGlobals());

describe("вебхук Telegram", () => {
	it("без секрета чи з чужим — 401, нічого не створює", async () => {
		const { send, sessions, calls } = setup();
		expect((await send(msg({ text: "задача" }), {})).status).toBe(401);
		expect((await send(msg({ text: "задача" }), { "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
		expect(sessions.size).toBe(0);
		expect(calls).toEqual([]);
	});

	it("текст → сесія з цим промптом і відповідь із посиланням, ✍ на повідомленні", async () => {
		const { send, sessions, replies, calls } = setup();
		expect((await send(msg({ text: "Поправ README" }))).status).toBe(200);
		expect([...sessions.values()].map((s) => s.input)).toEqual([{ prompt: "Поправ README" }]);
		expect(replies()).toEqual([`🔗 https://agent.example/s/tg-${OWNER}-7`]);
		expect(calls.find((c) => c.method === "setMessageReaction")?.body).toMatchObject({ message_id: 7 });
	});

	it("голосове → транскрипція Whisper стає промптом, у відповіді видно, що розібрано", async () => {
		const { send, sessions, replies, llm } = setup("Додай CHANGELOG");
		await send(msg({ voice: { file_id: "f1", file_size: 1000, mime_type: "audio/ogg" } }));
		expect(llm.transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), "audio/ogg");
		expect([...sessions.values()][0].input.prompt).toBe("Додай CHANGELOG");
		expect(replies()).toEqual([`🗣 Додай CHANGELOG\n\n🔗 https://agent.example/s/tg-${OWNER}-7`]);
	});

	it("повторна доставка того самого повідомлення не створює другу сесію", async () => {
		const { send, sessions, replies } = setup();
		await send(msg({ text: "Поправ README" }));
		await send(msg({ text: "Поправ README" }));
		expect(sessions.size).toBe(1);
		expect(new Set(replies()).size).toBe(1); // посилання те саме
	});

	it("інше повідомлення — інша сесія", async () => {
		const { send, sessions } = setup();
		await send(msg({ text: "перша" }, 7));
		await send(msg({ text: "друга" }, 8));
		expect(sessions.size).toBe(2);
	});

	it("чужий користувач, канал і група ігноруються", async () => {
		const { send, sessions, calls } = setup();
		await send({ ...msg({ text: "задача" }), from: { id: 7 }, chat: { id: 7, type: "private" } });
		await send({ ...msg({ text: "задача" }), chat: { id: -100, type: "channel" } });
		await send({ ...msg({ text: "задача" }), chat: { id: -5, type: "group" } });
		expect(sessions.size).toBe(0);
		expect(calls).toEqual([]);
	});

	it("порожня транскрипція й завеликий файл — підказка, сесії немає", async () => {
		const empty = setup("");
		await empty.send(msg({ voice: { file_id: "f1", file_size: 10 } }));
		expect(empty.sessions.size).toBe(0);
		expect(empty.replies()[0]).toContain("Не розібрав");

		const big = setup();
		await big.send(msg({ voice: { file_id: "f1", file_size: 25_000_000 } }));
		expect(big.sessions.size).toBe(0);
		expect(big.llm.transcribe).not.toHaveBeenCalled();
		expect(big.replies()[0]).toContain("20 МБ");
	});

	it("/start і команди сесії не створюють", async () => {
		const { send, sessions, replies } = setup();
		await send(msg({ text: "/start" }));
		await send(msg({ text: "/help" }, 8));
		expect(sessions.size).toBe(0);
		expect(replies()).toHaveLength(1);
	});

	it("збій агента — повідомлення про помилку, а Telegram усе одно отримує 200", async () => {
		const { send, agent, replies } = setup();
		agent.start = async () => {
			throw new Error("boom");
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await send(msg({ text: "задача" }))).status).toBe(200);
		expect(replies()[0]).toContain("Не вдалося створити сесію");
	});
});
