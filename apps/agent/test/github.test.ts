import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleGithub } from "../src/interface/github";
import { handleTelegram } from "../src/interface/telegram";
import { fakeAgent } from "./fake-agent";

vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

const SECRET = "whsec";
const env = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42", CHAT_ID: "-1001", GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN: "ghp", GITHUB_APPROVE_TOKEN: "appr" } as unknown as Env;

async function sign(body: string) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let pullBranch = "agent/fix-7";
let pullRepo = "me/bot";

function setup() {
	pullBranch = "agent/fix-7";
	pullRepo = "me/bot";
	const agent = fakeAgent();
	const calls: { url: string; method: string; body?: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(init.body as string) : undefined;
			calls.push({ url: input, method: init?.method ?? "GET", body });
			if (input.includes("/pending_deployments") && (init?.method ?? "GET") === "GET") return Response.json([{ environment: { id: 9 }, current_user_can_approve: true }]);
			if (input.includes("/commits/") && input.endsWith("/pulls")) return Response.json([{ number: 5, title: "Fix", html_url: "https://github.com/me/bot/pull/5", head: { ref: pullBranch, repo: { full_name: pullRepo } } }]);
			if (input.includes("api.github.com")) return new Response(null, { status: 204 });
			return Response.json({ ok: true, result: { message_id: 500 } });
		}),
	);
	const pending: Promise<unknown>[] = [];
	const deps = { agent: agent.agent, defer: (w: Promise<unknown>) => void pending.push(w) };
	const hook = async (event: string, payload: unknown, signature?: string) => {
		const body = JSON.stringify(payload);
		const res = await handleGithub(new Request("https://agent.example/github", { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": signature ?? (await sign(body)) }, body }), env, deps);
		await Promise.all(pending.splice(0));
		return res;
	};
	const tgCalls = (method: string) => calls.filter((c) => c.url.endsWith(`/${method}`)).map((c) => c.body as Record<string, unknown>);
	return { ...agent, calls, hook, tgCalls, deps, pending };
}

afterEach(() => vi.unstubAllGlobals());

describe("вебхук GitHub", () => {
	it("без підпису чи з чужим — 401", async () => {
		const s = setup();
		expect((await s.hook("workflow_run", { action: "completed", repository: { full_name: "me/bot", default_branch: "main" } }, "sha256=bad")).status).toBe(401);
		expect(s.calls).toEqual([]);
	});

	const deploy = (over: Record<string, unknown> = {}) => ({ action: "completed", repository: { full_name: "me/bot", default_branch: "main" }, workflow_run: { id: 1, name: "deploy", head_branch: "main", head_sha: "abc", html_url: "https://github.com/me/bot/actions/runs/1", conclusion: "success", ...over } });

	it("успішний деплой PR бота: сесія прибрана, пост видалено, віддалену гілку видалено", async () => {
		const s = setup();
		await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
		expect((await s.hook("workflow_run", deploy())).status).toBe(200);
		expect(s.sessions.size).toBe(0);
		expect(s.calls.find((c) => c.method === "DELETE" && c.url.endsWith("/repos/me/bot/git/refs/heads/agent/fix-7"))).toBeTruthy();
		expect(s.tgCalls("deleteMessage")[0]).toMatchObject({ chat_id: -1001, message_id: 77 });
		expect(s.tgCalls("sendMessage")[0].text).toContain("🧹");
	});

	it("невдалий деплой, не agent/* і форк сесію лишають", async () => {
		const s = setup();
		await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
		await s.hook("workflow_run", deploy({ conclusion: "failure" }));
		pullBranch = "feature/fix-7";
		await s.hook("workflow_run", deploy());
		pullBranch = "agent/fix-7";
		pullRepo = "evil/bot";
		await s.hook("workflow_run", deploy());
		expect(s.sessions.size).toBe(1);
		expect(s.calls.some((c) => c.method === "DELETE")).toBe(false);
	});

	it("запит на схвалення деплою → пост з кнопками, кнопка схвалює через GitHub", async () => {
		const s = setup();
		await s.hook("workflow_job", { action: "waiting", repository: { full_name: "me/bot", default_branch: "main" }, workflow_job: { run_id: 123, name: "deploy-agent / deploy", workflow_name: "deploy", head_branch: "main", html_url: "https://github.com/me/bot/actions/runs/123/job/1" } });
		await s.hook("workflow_job", { action: "completed", repository: { full_name: "me/bot", default_branch: "main" }, workflow_job: { run_id: 124, name: "x", html_url: "u" } }); // інші статуси ігноруємо
		expect(s.tgCalls("sendMessage")).toHaveLength(1);
		const sent = s.tgCalls("sendMessage")[0] as { chat_id: string; text: string; reply_markup: { inline_keyboard: { callback_data: string }[][] } };
		expect(sent.chat_id).toBe("42");
		expect(sent.text).toContain("deploy-agent");
		expect(sent.reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual(["appr:me/bot:123", "rej:me/bot:123"]);

		const query = { id: "q", from: { id: 42 }, message: { message_id: 8, chat: { id: -1001, type: "channel" }, text: sent.text }, data: "appr:me/bot:123" };
		await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), env, { ...s.deps, llm: {} as never });
		await Promise.all(s.pending.splice(0));
		expect(s.calls.find((c) => c.method === "POST" && c.url.endsWith("/runs/123/pending_deployments"))?.body).toMatchObject({ environment_ids: [9], state: "approved" });
		expect(s.tgCalls("editMessageText")[0].text).toContain("✅ Схвалено");
		expect(s.tgCalls("answerCallbackQuery")[0].text).toBe("✅ Схвалено");
	});

	it("результат деплою на main → пост з PR; чужі workflow і гілки ігноруються", async () => {
		const s = setup();
		const run = (over: Record<string, unknown>) => ({ action: "completed", repository: { full_name: "me/bot", default_branch: "main" }, workflow_run: { id: 1, name: "deploy", head_branch: "main", head_sha: "abc", html_url: "https://github.com/me/bot/actions/runs/1", conclusion: "success", ...over } });
		await s.hook("workflow_run", run({ name: "check" }));
		await s.hook("workflow_run", run({ head_branch: "agent/x" }));
		await s.hook("workflow_run", run({ conclusion: "skipped" }));
		expect(s.tgCalls("sendMessage")).toEqual([]);
		await s.hook("workflow_run", run({}));
		await s.hook("workflow_run", run({ conclusion: "failure" }));
		const texts = s.tgCalls("sendMessage").map((c) => c.text as string);
		expect(texts[0]).toContain("✅ Деплой успішний");
		expect(texts[0]).toContain("PR #5: Fix");
		expect(texts[1]).toContain("❌ Деплой не вдався");
	});

	it("кнопку схвалення від чужого натиснути не можна", async () => {
		const s = setup();
		const query = { id: "q", from: { id: 1 }, message: { message_id: 8, chat: { id: -1001, type: "channel" } }, data: "appr:me/bot:123" };
		await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), env, { ...s.deps, llm: {} as never });
		await Promise.all(s.pending.splice(0));
		expect(s.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
	});
});
