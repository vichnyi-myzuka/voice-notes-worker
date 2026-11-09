import { afterEach, describe, expect, it, vi } from "vitest";
import { receiveTelegramVoice, telegramMessageUrl } from "../src/telegram";
import { fakeEnv } from "./fake-env";

afterEach(() => vi.unstubAllGlobals());

describe("telegramMessageUrl", () => {
	it("посилання лише для каналів і супергруп", () => {
		expect(telegramMessageUrl("-1004390223227", 5)).toBe("https://t.me/c/4390223227/5");
		expect(telegramMessageUrl("230295237", 5)).toBeNull();
	});
});

describe("receiveTelegramVoice", () => {
	const env = fakeEnv({ TG_OWNER_ID: "230295237" });
	const voice = { file_id: "f", file_size: 1000 };
	const base = { message_id: 1, date: 1 };

	it.each([
		["чужий користувач у приваті", { ...base, chat: { id: 1, type: "private" }, from: { id: 1 }, voice }],
		["голосове з підписом у каналі (нотатка бота)", { ...base, chat: { id: -1004390223227, type: "channel" }, caption: "Назва", voice }],
		["інший канал", { ...base, chat: { id: -1001, type: "channel" }, voice }],
		["група", { ...base, chat: { id: -5, type: "group" }, from: { id: 230295237 }, voice }],
	])("ігнорує: %s", async (_, msg) => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn();
		await receiveTelegramVoice(env, msg, store);
		expect(store).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("текст без відповіді на нотатку в каналі ігнорується", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn();
		await receiveTelegramVoice(env, { ...base, chat: { id: -1004390223227, type: "channel" }, text: "просто текст" }, store);
		expect(store).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("текстова відповідь на нотатку в каналі — інструкція редагування без завантаження файлу", async () => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
		vi.stubGlobal("fetch", fetchSpy);
		const store = vi.fn();
		await receiveTelegramVoice(
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
		const store = vi.fn();
		await receiveTelegramVoice(
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
});
