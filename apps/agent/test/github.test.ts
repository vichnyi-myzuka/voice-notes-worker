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
		const sent = s.tgCalls("sendMessage")[0] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } };
		expect(sent.reply_markup.inline_keyboard[0][0].callback_data).toBe("dismiss");
	});

	describe("збій check на гілці бота", () => {
		const check = (over: Record<string, unknown> = {}, repository = { full_name: "me/bot", default_branch: "main" }) => ({ action: "completed", repository, workflow_run: { id: 9, name: "check", head_branch: "agent/fix-7", head_sha: "abc", html_url: "https://github.com/me/bot/actions/runs/9", conclusion: "failure", head_repository: { full_name: "me/bot" }, ...over } });

		it("пише в чат і дає сесії завдання виправити CI", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			await s.hook("workflow_run", check());
			expect(s.tgCalls("sendMessage")[0]).toMatchObject({ chat_id: -1001 });
			expect(s.tgCalls("sendMessage")[0].text).toContain("CI не пройшов у agent/fix-7");
			const messages = s.sessions.get("tg--1001-7")!.messages;
			expect(messages).toHaveLength(2);
			expect(messages[1]).toContain("actions/runs/9");
			expect(s.watches.at(-1)).toMatchObject({ id: "tg--1001-7", target: { chatId: -1001 } });
		});

		it("успіх, інші workflow, чужі гілки, форки й сесії без репозиторію ігноруються", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			await s.hook("workflow_run", check({ conclusion: "success" }));
			await s.hook("workflow_run", check({ conclusion: "cancelled" }));
			await s.hook("workflow_run", check({ name: "lint" }));
			await s.hook("workflow_run", check({ head_branch: "feature/fix-7" }));
			await s.hook("workflow_run", check({ head_repository: { full_name: "evil/bot" } }));
			await s.hook("workflow_run", check({ head_branch: "agent/nope-1" }));
			expect(s.tgCalls("sendMessage")).toEqual([]);
			expect(s.sessions.get("tg--1001-7")!.messages).toHaveLength(1);
		});
	});

	it("кнопка «Видалити» під результатом деплою видаляє повідомлення (лише від власника)", async () => {
		const s = setup();
		const press = async (from: number) => {
			const query = { id: "q", from: { id: from }, message: { message_id: 9, chat: { id: 42, type: "private" }, text: "x" }, data: "dismiss" };
			await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), env, { ...s.deps, llm: {} as never });
			await Promise.all(s.pending.splice(0));
		};
		await press(7);
		expect(s.tgCalls("deleteMessage")).toEqual([]);
		await press(42);
		expect(s.tgCalls("deleteMessage")[0]).toMatchObject({ chat_id: 42, message_id: 9 });
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

	it("результат деплою дописується в пост зі схваленням того ж запуску, а не йде новим повідомленням", async () => {
		const s = setup();
		const repository = { full_name: "me/bot", default_branch: "main" };
		await s.hook("workflow_job", { action: "waiting", repository, workflow_job: { run_id: 123, name: "deploy-agent / deploy", workflow_name: "deploy", head_branch: "main", html_url: "u" } });
		expect(s.tgCalls("sendMessage")).toHaveLength(1);
		await s.hook("workflow_run", deploy({ id: 123 }));
		expect(s.tgCalls("sendMessage")).toHaveLength(1); // нового повідомлення немає
		const edit = s.tgCalls("editMessageText")[0] as { chat_id: string; message_id: number; text: string; reply_markup: { inline_keyboard: { callback_data: string }[][] } };
		expect(edit).toMatchObject({ chat_id: "42", message_id: 500 });
		expect(edit.text).toContain("🚀 Деплой чекає схвалення");
		expect(edit.text).toContain("✅ Деплой успішний");
		expect(edit.reply_markup.inline_keyboard[0][0].callback_data).toBe("dismiss");
		await s.hook("workflow_run", deploy({ id: 123 })); // повторно пост уже не знайдеться: звичайне повідомлення
		expect(s.tgCalls("sendMessage")).toHaveLength(2);
	});

	it("деплой PR бота показується в пості його сесії: схвалення, а після успіху сесія прибрана, а пост лишається", async () => {
		const s = setup();
		await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
		s.sessions.get("tg--1001-7")!.posted = true;
		const repository = { full_name: "me/bot", default_branch: "main" };
		await s.hook("workflow_job", { action: "waiting", repository, workflow_job: { run_id: 123, head_sha: "abc", name: "deploy", html_url: "https://github.com/x/job" } });
		expect(s.tgCalls("sendMessage")).toEqual([]); // окремого повідомлення немає
		expect(s.deploys[0]).toMatchObject({ repo: "me/bot", folder: "fix-7", deploy: { runId: 123 } });
		await s.hook("workflow_run", deploy({ id: 123 }));
		expect(s.deploys[1].deploy).toMatchObject({ done: true });
		expect(s.deploys[1].deploy.text).toContain("✅ Деплой успішний");
		expect(s.sessions.size).toBe(0);
		expect(s.tgCalls("sendMessage")).toEqual([]);
		expect(s.tgCalls("deleteMessage")).toEqual([]); // пост лишається
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

	describe("кнопка «Змерджити» під постом сесії", () => {
		const press = async (s: ReturnType<typeof setup>, from = 42) => {
			const query = { id: "q", from: { id: from }, message: { message_id: 77, chat: { id: -1001, type: "channel" }, text: "x" }, data: "merge:tg--1001-7" };
			await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), env, { ...s.deps, llm: {} as never });
			await Promise.all(s.pending.splice(0));
		};
		const withPulls = (s: ReturnType<typeof setup>, pulls: unknown[], mergeStatus = 200) => {
			const base = globalThis.fetch;
			vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
				if (input.includes("/pulls?state=open")) { s.calls.push({ url: input, method: "GET" }); return Response.json(pulls); }
				if (input.endsWith("/merge")) { s.calls.push({ url: input, method: init?.method ?? "", body: JSON.parse(init!.body as string) }); return mergeStatus === 200 ? Response.json({ merged: true }) : Response.json({ message: "Required status check is expected" }, { status: mergeStatus }); }
				return base(input, init);
			}));
		};

		it("мерджить PR гілки сесії і прибирає кнопку з поста", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			withPulls(s, [{ number: 5 }]);
			await press(s);
			expect(s.calls.find((c) => c.url.includes("/pulls?state=open"))?.url).toContain("head=me%3Aagent%2Ffix-7");
			expect(s.calls.find((c) => c.method === "PUT")).toMatchObject({ url: "https://api.github.com/repos/me/bot/pulls/5/merge", body: { merge_method: "merge" } });
			// пост одразу показує «змерджено, чекаємо на деплой» (без очікування вебхука)
			expect(s.deploys).toEqual([{ postId: 77, deploy: { text: "🔀 PR #5 змерджено, чекаємо на деплой", stage: "deploying" } }]);
			expect(s.tgCalls("answerCallbackQuery")[0].text).toBe("🔀 PR #5 змерджено");
		});

		it("репозиторій із site: після мержу сесії дописується завдання опублікувати main; без site — ні", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			withPulls(s, [{ number: 5 }]);
			await press(s);
			expect(s.sessions.get("tg--1001-7")?.messages).toEqual(["p"]);

			const withSite = { ...env, AGENT_REPOS: JSON.stringify([{ repo: "me/bot", about: "x", site: "my-game" }]) } as unknown as Env;
			const query = { id: "q", from: { id: 42 }, message: { message_id: 77, chat: { id: -1001, type: "channel" }, text: "x" }, data: "merge:tg--1001-7" };
			await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), withSite, { ...s.deps, llm: {} as never });
			await Promise.all(s.pending.splice(0));
			const messages = s.sessions.get("tg--1001-7")!.messages;
			expect(messages).toHaveLength(2);
			expect(messages[1]).toContain("publish --public <dir> my-game");
			expect(messages[1]).toContain("#5");
		});

		it("відмова GitHub (перевірки не пройшли) показується в підказці, кнопка лишається", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			withPulls(s, [{ number: 5 }], 405);
			vi.spyOn(console, "error").mockImplementation(() => {});
			await press(s);
			expect(s.tgCalls("answerCallbackQuery")[0].text).toBe("Не вдалося змерджити: Required status check is expected");
			expect(s.tgCalls("editMessageReplyMarkup")).toEqual([]);
		});

		it("відмова з конфліктом і провалленим CI: причини в підказці та окремим повідомленням у чаті", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			withPulls(s, [{ number: 5 }], 405);
			const merging = globalThis.fetch;
			vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
				if (input.endsWith("/pulls/5")) return Response.json({ draft: false, mergeable: false, mergeable_state: "dirty", head: { sha: "abc" } });
				if (input.includes("/commits/abc/check-runs")) return Response.json({ check_runs: [{ name: "check", status: "completed", conclusion: "failure" }, { name: "lint", status: "in_progress", conclusion: null }, { name: "ok", status: "completed", conclusion: "success" }] });
				return merging(input, init);
			}));
			vi.spyOn(console, "error").mockImplementation(() => {});
			await press(s);
			expect(s.tgCalls("answerCallbackQuery")[0].text).toBe("Не вдалося змерджити PR #5: Є конфлікти з основною гілкою; CI не пройшов: check; CI ще виконується: lint");
			const sent = s.tgCalls("sendMessage")[0];
			expect(sent).toMatchObject({ chat_id: -1001 });
			expect(sent.text).toContain("• Є конфлікти з основною гілкою");
			expect(sent.text).toContain("• CI не пройшов: check");
			expect(sent.text).toContain("GitHub: Required status check is expected");
			expect(s.tgCalls("editMessageReplyMarkup")).toEqual([]);
		});

		it("без відкритого PR і від чужого нічого не мерджить", async () => {
			const s = setup();
			await s.agent.start("tg--1001-7", { prompt: "p", repo: "me/bot", name: "fix" });
			withPulls(s, []);
			await press(s);
			expect(s.tgCalls("answerCallbackQuery")[0].text).toBe("Відкритого PR не знайдено.");
			await press(s, 1);
			expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
		});
	});

	it("помилка схвалення деплою містить причину від GitHub", async () => {
		const s = setup();
		vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
			s.calls.push({ url: input, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
			return input.includes("/pending_deployments") ? new Response(null, { status: 403 }) : Response.json({ ok: true, result: { message_id: 1 } });
		}));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const query = { id: "q", from: { id: 42 }, message: { message_id: 8, chat: { id: -1001, type: "channel" }, text: "x" }, data: "appr:me/bot:123" };
		await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), env, { ...s.deps, llm: {} as never });
		await Promise.all(s.pending.splice(0));
		expect(s.tgCalls("answerCallbackQuery")[0].text).toBe("Не вдалося звернутись до GitHub: pending deployments 403");
	});

	it("кнопку схвалення від чужого натиснути не можна", async () => {
		const s = setup();
		const query = { id: "q", from: { id: 1 }, message: { message_id: 8, chat: { id: -1001, type: "channel" } }, data: "appr:me/bot:123" };
		await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ callback_query: query }) }), env, { ...s.deps, llm: {} as never });
		await Promise.all(s.pending.splice(0));
		expect(s.calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
	});
});
