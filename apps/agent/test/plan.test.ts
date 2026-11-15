import { describe, expect, it } from "vitest";
import type { Llm } from "@voice-notes/core";
import { planTask } from "../src/application/task";

// Роутер повертає задану відповідь; весь вибір (префікси, MCP, модель) перевіряється без Telegram.
const llm = (answer: Record<string, unknown>): Llm => ({ askJson: async (_req: unknown, parse: (t: string) => unknown) => parse(JSON.stringify({ type: "feat", name: "x", ...answer })) }) as unknown as Llm;
const repos = [{ repo: "me/bot", about: "наш бот" }];

describe("planTask: що вирішено про нову задачу", () => {
	it("явні префікси репозиторію, моделі й сервісів знімаються з тексту й вмикають сервіси одразу", async () => {
		const plan = await planTask(llm({}), repos, "модель опус, шур, me/bot: порахуй витрати");
		expect(plan).toMatchObject({ prompt: "порахуй витрати", repo: "me/bot", model: "opus", mcp: { sure: true }, ask: [], askRepo: false });
	});

	it("роутер вмикає одразу лише сервіси для читання; ті, що змінюють дані, і сумніви йдуть у ask", async () => {
		const plan = await planTask(llm({ groceries: true, finance: true, maybe: ["cloudflare"] }), [], "що я купував і витрачав");
		expect(plan.mcp).toEqual({ silpo: true });
		expect(plan.ask).toEqual(["sure", "cloudflare"]);
		expect(plan.model).toBe("haiku"); // задачі з даними власника прості
	});

	it("Cloudflare не знижує модель до haiku; без впевненості в репозиторії просить вибір", async () => {
		const plan = await planTask(llm({ cloudflare: true, unsure: true, evidence: "", repo: "none" }), repos, "дивись воркери");
		expect(plan.mcp).toEqual({ cloudflare: true });
		expect(plan.model).toBeUndefined();
		expect(plan.askRepo).toBe(true);
	});
});
