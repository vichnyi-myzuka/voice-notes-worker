import { afterEach, describe, expect, it, vi } from "vitest";
import { receiveTelegramMessage, telegramMessageUrl, textNote, tgSendNote, type ReceivedMessage } from "../src/infrastructure/telegram";
import { fakeEnv } from "./fake-env";

afterEach(() => vi.unstubAllGlobals());

describe("telegramMessageUrl", () => {
	it("посилання лише для каналів і супергруп", () => {
		expect(telegramMessageUrl("-1004390223227", 5)).toBe("https://t.me/c/4390223227/5");
		expect(telegramMessageUrl("111111111", 5)).toBeNull();
	});
});

describe("receiveTelegramMessage", () => {
	const env = fakeEnv({ TG_OWNER_ID: "111111111" });
	const voice = { file_id: "f", file_size: 1000 };
	const base = { message_id: 1, date: 1 };

	it.each([
		["чужий користувач у приваті", { ...base, chat: { id: 1, type: "private" }, from: { id: 1 }, voice }],
		["голосове з підписом у каналі (нотатка бота)", { ...base, chat: { id: -1004390223227, type: "channel" }, caption: "Назва", voice }],
		["інший канал", { ...base, chat: { id: -1001, type: "channel" }, voice }],
		["група", { ...base, chat: { id: -5, type: "group" }, from: { id: 111111111 }, voice }],
	])("ігнорує: %s", async (_, msg) => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(env, msg, store);
		expect(store).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each([
		["порожній текст", { ...base, chat: { id: -1004390223227, type: "channel" }, text: "" }],
		["лише пробіли", { ...base, chat: { id: -1004390223227, type: "channel" }, text: " \n\t " }],
		["команда /start у каналі", { ...base, chat: { id: -1004390223227, type: "channel" }, text: "/start" }],
		["команда з аргументами", { ...base, chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/help me" }],
		["текст від чужого в приваті", { ...base, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "привіт" }],
		["текст в іншому каналі", { ...base, chat: { id: -1001, type: "channel" }, text: "привіт" }],
		["текст у групі", { ...base, chat: { id: -5, type: "group" }, from: { id: 111111111 }, text: "привіт" }],
		["текст з підписом у каналі", { ...base, chat: { id: -1004390223227, type: "channel" }, caption: "x", text: "привіт" }],
	])("текст не стає нотаткою: %s", async (_, msg) => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(env, msg, store);
		expect(store).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("/start від власника в приваті — лише відповідь, без нотатки", async () => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(env, { ...base, chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/start" }, store);
		expect(store).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("sendMessage");
	});

	it("звичайний текст у каналі — нова нотатка з даними для видалення", async () => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(env, { ...base, message_id: 9, chat: { id: -1004390223227, type: "channel" }, text: "Купити хліб і зателефонувати мамі" }, store);
		expect(store).toHaveBeenCalledOnce();
		const [key, body, meta] = store.mock.calls[0];
		expect(key).toMatch(/^1000-[0-9a-f]{8}\.txt$/);
		expect(new TextDecoder().decode(body)).toBe("Купити хліб і зателефонувати мамі");
		expect(meta).toEqual({
			contentType: "text/plain; charset=utf-8",
			kind: "text",
			deleteChatId: "-1004390223227",
			deleteMessageId: "9",
		});
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("setMessageReaction");
	});

	it("звичайний текст від власника в приваті — нотатка без даних для видалення", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true })));
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(env, { ...base, chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "ідея для проєкту" }, store);
		expect(store).toHaveBeenCalledOnce();
		const [key, , meta] = store.mock.calls[0];
		expect(key).toMatch(/\.txt$/);
		expect(meta).toEqual({ contentType: "text/plain; charset=utf-8", kind: "text" });
		expect(meta).not.toHaveProperty("deleteMessageId");
		expect(meta).not.toHaveProperty("deleteChatId");
	});

	it("текстова відповідь на нотатку в каналі — інструкція редагування без завантаження файлу", async () => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(
			env,
			{ ...base, message_id: 8, chat: { id: -1004390223227, type: "channel" }, text: "Зроби все на сьогодні", reply_to_message: { message_id: 5 } },
			store,
		);
		expect(store).toHaveBeenCalledOnce();
		const [key, body, meta] = store.mock.calls[0];
		expect(key).toMatch(/^1000-[0-9a-f]{8}\.txt$/);
		expect(new TextDecoder().decode(body)).toBe("Зроби все на сьогодні");
		expect(meta).toMatchObject({ kind: "text", contentType: "text/plain; charset=utf-8", deleteMessageId: "8", replyTo: "5" });
		// лише реакція ✍, без getFile
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("setMessageReaction");
	});

	it("правка, яку store вже прибрав (повертає false), — без реакції ✍", async () => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => false);
		await receiveTelegramMessage(
			env,
			{ ...base, message_id: 8, chat: { id: -1004390223227, type: "channel" }, text: "Зроби все на сьогодні", reply_to_message: { message_id: 5 } },
			store,
		);
		expect(store).toHaveBeenCalledOnce();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("приймає голосове без підпису в каналі, з даними для видалення й редагування", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("/getFile")
					? Response.json({ result: { file_path: "voice/f.oga" } })
					: url.includes("/file/")
						? new Response(new Uint8Array([1, 2, 3]))
						: Response.json({ ok: true }),
			),
		);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(
			env,
			{ ...base, message_id: 7, chat: { id: -1004390223227, type: "channel" }, voice, reply_to_message: { message_id: 5 } },
			store,
		);
		expect(store).toHaveBeenCalledOnce();
		const [key, , meta] = store.mock.calls[0];
		expect(key).toMatch(/^1000-[0-9a-f]{8}\.ogg$/);
		expect(meta).toMatchObject({
			kind: "voice",
			contentType: "audio/ogg",
			deleteChatId: "-1004390223227",
			deleteMessageId: "7",
			replyTo: "5",
		});
	});

	it("фото з підписом у каналі — найбільший розмір, підпис без пробілів, без replyTo", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("/getFile")
					? Response.json({ result: { file_path: "photos/f.jpg" } })
					: url.includes("/file/")
						? new Response(new Uint8Array([1, 2, 3]))
						: Response.json({ ok: true }),
			),
		);
		const store = vi.fn(async (_k: string, _b: ArrayBuffer, _m: ReceivedMessage) => true);
		await receiveTelegramMessage(
			env,
			{
				...base,
				message_id: 11,
				chat: { id: -1004390223227, type: "channel" },
				caption: "  Чек з аптеки \n",
				photo: [
					{ file_id: "small", file_size: 100 },
					{ file_id: "big", file_size: 1000 },
				],
				reply_to_message: { message_id: 5 },
			},
			store,
		);
		expect(store).toHaveBeenCalledOnce();
		const [key, , meta] = store.mock.calls[0];
		expect(key).toMatch(/^1000-[0-9a-f]{8}\.jpg$/);
		expect(meta).toEqual({
			kind: "photo",
			contentType: "image/jpeg",
			fileId: "big",
			caption: "Чек з аптеки",
			deleteChatId: "-1004390223227",
			deleteMessageId: "11",
		});
		expect(meta).not.toHaveProperty("replyTo");
	});
});

describe("tgSendNote", () => {
	it("фото з fileId іде через sendPhoto з photo і підписом", async () => {
		const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ result: { message_id: 42 } }));
		vi.stubGlobal("fetch", fetchSpy);
		const id = await tgSendNote(fakeEnv(), { blob: async () => new Blob(), fileId: "big", kind: "photo" }, "Назва", "Підпис");
		expect(id).toBe(42);
		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toContain("/sendPhoto");
		expect(JSON.parse(String(init.body))).toMatchObject({ photo: "big", caption: "Підпис" });
	});
});

describe("textNote", () => {
	const quote = (e: object[]) => e.find((x) => (x as { type: string }).type === "expandable_blockquote");

	it("підпис, порожній рядок, оригінал; цитата охоплює оригінал", () => {
		const r = textNote("Назва\n\nSummary", "Оригінальний текст");
		expect(r.text).toBe("Назва\n\nSummary\n\nОригінальний текст");
		expect(r.entities).toEqual([{ type: "expandable_blockquote", offset: "Назва\n\nSummary\n\n".length, length: "Оригінальний текст".length }]);
	});

	it("рівно в ліміт: без обрізання", () => {
		const caption = "c".repeat(100);
		const original = "o".repeat(4096 - 102);
		const r = textNote(caption, original);
		expect(r.text.length).toBe(4096);
		expect(r.text.endsWith(original)).toBe(true);
		expect(r.text).not.toContain("…");
	});

	it("на символ більше ліміту: обрізається з …, разом 4096", () => {
		const caption = "c".repeat(100);
		const r = textNote(caption, "o".repeat(4096 - 102 + 1));
		expect(r.text.length).toBe(4096);
		expect(r.text.endsWith("…")).toBe(true);
		expect(quote(r.entities)).toEqual({ type: "expandable_blockquote", offset: 102, length: 4096 - 102 });
	});

	it("довгий оригінал: цитата закінчується в кінці тексту", () => {
		const r = textNote("Підпис", "x".repeat(10_000));
		const q = quote(r.entities) as { offset: number; length: number };
		expect(r.text.length).toBe(4096);
		expect(q.offset + q.length).toBe(r.text.length);
	});

	it("додає цитату після переданих entities", () => {
		const link = { type: "text_link" as const, offset: 0, length: 3, url: "https://x" };
		const r = textNote("abc", "orig", [link]);
		expect(r.entities).toEqual([link, { type: "expandable_blockquote", offset: 5, length: 4 }]);
	});

	it("emoji: офсети й довжини в UTF-16", () => {
		const caption = "🎙 Назва 😀";
		const original = "Текст 👍🏽 ok";
		const r = textNote(caption, original);
		const q = quote(r.entities) as { offset: number; length: number };
		expect(caption.length).toBeGreaterThan([...caption].length);
		expect(q.offset).toBe(caption.length + 2);
		expect(q.length).toBe(original.length);
		expect(r.text.slice(q.offset, q.offset + q.length)).toBe(original);
	});
});
