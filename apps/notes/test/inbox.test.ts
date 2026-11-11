import { describe, expect, it, vi } from "vitest";
import { workersLlm, type Channel, type Incoming } from "@voice-notes/core";
import type { Ports } from "../src/application/pipeline";
import { r2Ledger, r2Notes } from "../src/infrastructure/r2";
import { todoistTracker } from "../src/infrastructure/todoist";
import { handleFetch } from "../src/interface/inbox";
import { fakeEnv } from "./fake-env";

// Канал-заглушка: перевіряє, що inbox працює лише з інтерфейсом Channel, без Telegram.
function fakeChannel(incoming?: { key: string; body: ArrayBuffer; incoming: Incoming }) {
	const calls: string[] = [];
	const channel = {
		webhookPath: "/hook",
		webhook: async (_req, onIncoming) => {
			if (incoming) calls.push(`kept:${await onIncoming(incoming.key, incoming.body, incoming.incoming)}`);
			return new Response("hooked");
		},
		setBusy: async (id, busy) => void calls.push(`busy:${id}:${busy}`),
		removeOrigin: async (origin) => void calls.push(`origin:${JSON.stringify(origin)}`),
	} as Channel;
	return { channel, calls };
}

// Inbox потребує лише канал і сховище нотаток; трекер не викликається.
const ports = (channel: Channel, env: ReturnType<typeof envWith>): Ports => ({
	channel,
	tracker: todoistTracker(env),
	notes: r2Notes(env),
	ledger: r2Ledger(env),
	llm: workersLlm(env),
});

const send = vi.fn(async () => {});
const envWith = () => ({ ...fakeEnv({ SECRET: "s" }), QUEUE: { send } as unknown as Queue });

describe("handleFetch", () => {
	it("не-POST → 405", async () => {
		const { channel } = fakeChannel();
		const res = await handleFetch(new Request("https://x/hook"), envWith(), ports(channel, envWith()));
		expect(res.status).toBe(405);
	});

	it("шлях вебхука каналу віддається каналу", async () => {
		const { channel } = fakeChannel();
		const res = await handleFetch(new Request("https://x/hook", { method: "POST" }), envWith(), ports(channel, envWith()));
		expect(await res.text()).toBe("hooked");
	});

	it("шорткат без налаштованого SECRET → 500", async () => {
		const { channel } = fakeChannel();
		const res = await handleFetch(new Request("https://x/", { method: "POST", body: "a" }), { ...envWith(), SECRET: "" }, ports(channel, envWith()));
		expect(res.status).toBe(500);
	});

	it("нова нотатка: оригінал лишається, службові дані й origin у R2", async () => {
		const env = envWith();
		const { channel, calls } = fakeChannel({
			key: "1-a.ogg",
			body: new ArrayBuffer(1),
			incoming: { contentType: "audio/ogg", metadata: { kind: "voice" }, origin: { deleteMessageId: "9" } },
		});
		await handleFetch(new Request("https://x/hook", { method: "POST" }), env, ports(channel, env));
		expect(calls).toEqual(["kept:true"]);
		expect(env.store.has("1-a.ogg")).toBe(true);
	});

	it("правка: відповідь прибирається, нотатка позначається, origin не потрапляє в чергу", async () => {
		const env = envWith();
		env.store.set("notes/msg-5", "note-1");
		const { channel, calls } = fakeChannel({
			key: "1-b.ogg",
			body: new ArrayBuffer(1),
			incoming: { contentType: "audio/ogg", metadata: { kind: "voice" }, origin: { deleteMessageId: "9" }, replyTo: "5" },
		});
		await handleFetch(new Request("https://x/hook", { method: "POST" }), env, ports(channel, env));
		expect(calls).toEqual(["busy:5:true", 'origin:{"deleteMessageId":"9"}', "kept:false"]);
		expect(send).toHaveBeenLastCalledWith({ key: "1-b.ogg", edit: "note-1" });
	});
});
