import { afterEach, describe, expect, it, vi } from "vitest";
import { editChat, sendChat } from "../src/infrastructure/chat";

afterEach(() => vi.unstubAllGlobals());

describe("sendChat", () => {
	const stub = (reject: boolean) => {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			bodies.push(body);
			if (reject && body.parse_mode) return new Response("can't parse entities", { status: 400 });
			return Response.json({ ok: true, result: { message_id: 7 } });
		});
		return bodies;
	};

	it("шле HTML з посиланням на сесію внизу, без прев'ю, і повертає id повідомлення", async () => {
		const bodies = stub(false);
		expect(await sendChat({ BOT_TOKEN: "b" }, 5, "**Готово**", "https://agent.example/s/x")).toBe(7);
		expect(bodies).toEqual([{ chat_id: 5, text: '<b>Готово</b>\n\n🔗 <a href="https://agent.example/s/x">Відкрити сесію</a>', parse_mode: "HTML", link_preview_options: { is_disabled: true } }]);
	});

	it("Telegram відхилив розмітку: той самий текст надходить без неї", async () => {
		const bodies = stub(true);
		expect(await sendChat({ BOT_TOKEN: "b" }, 5, "**Готово**", "https://agent.example/s/x")).toBe(7);
		expect(bodies[1]).toEqual({ chat_id: 5, text: "**Готово**\n\n🔗 https://agent.example/s/x", link_preview_options: { is_disabled: true } });
	});
});

describe("кнопки під постом", () => {
	const SESSION = "https://agent.example/s/tg-5-7";
	const markup = async (call: (env: { BOT_TOKEN: string }) => Promise<unknown>) => {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(init.body as string)), Response.json({ ok: true, result: { message_id: 1 } })));
		await call({ BOT_TOKEN: "t" });
		return bodies[0].reply_markup;
	};

	it("працює: «Стоп» і «Видалити»; завершено: лише «Видалити»; без кнопок чи без посилання сесії — без клавіатури", async () => {
		const row = (r: unknown) => (r as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0].map((b) => b.callback_data);
		expect(row(await markup((env) => editChat(env, 5, 9, "x", SESSION, "working")))).toEqual(["stop:tg-5-7", "del:tg-5-7"]);
		expect(row(await markup((env) => editChat(env, 5, 9, "x", SESSION, "done")))).toEqual(["del:tg-5-7"]);
		expect(await markup((env) => sendChat(env, 5, "x", SESSION))).toBeUndefined();
		expect(await markup((env) => sendChat(env, 5, "x", undefined, "working"))).toBeUndefined();
	});
});

describe("callback_data MCP", () => {
	it("запит MCP до створення сесії й посеред неї розбирається й вкладається в 64 байти", async () => {
		const { callback, parseCallback } = await import("../src/infrastructure/chat");
		const id = "tg--1001234567890-1234567";
		expect(parseCallback(callback.mcpStart(id, true))).toEqual({ kind: "mcp-start", id, allow: true });
		expect(parseCallback(callback.mcpLive(id, "cloudflare", false))).toEqual({ kind: "mcp-live", id, name: "cloudflare", allow: false });
		expect(callback.mcpLive(id, "cloudflare", true).length).toBeLessThanOrEqual(64);
		expect(parseCallback(`mcpl:${id}:bank:y`)).toBeUndefined();
	});
});
