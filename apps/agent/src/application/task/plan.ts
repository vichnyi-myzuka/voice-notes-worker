import type { Llm } from "@voice-notes/core";
import { MCP_NAMES, MCP_WRITES, type McpFlags, type McpName } from "../../domain/agent";
import { REPO_PREFIX, parsePrefixes } from "./prefixes";
import type { KnownRepo } from "./repos";
import { routeTask, type Route } from "./route";

// Що вирішено про нову задачу з розшифровки: текст без префіксів, репозиторій, модель і MCP-сервіси.
export type TaskPlan = {
	prompt: string;
	route: Route;
	repo?: string;
	model?: string;
	// Сервіси, які вмикаємо одразу
	mcp: McpFlags;
	// Сервіси, які роутер вважає потрібними чи припускає, але вмикати без підтвердження не можна
	ask: McpName[];
	// Роутер не впевнений, чи це про відомий репозиторій (і про який): треба спитати власника
	askRepo: boolean;
};

// Вибір репозиторію, моделі й MCP для нової задачі. Явний префікс («owner/name:», «@opus», «шур, …») сильніший за здогад роутера;
// назву для теки/гілки модель придумує завжди.
//
// Sure підключається, коли власник назвав його явно («шур, …», «@sure») або модель побачила, що задача про його фінанси.
// Сільпо — явно («сільпо, …», «@silpo») або коли модель побачила, що треба дивитись, що власник купував. Календар, Cloudflare — так само.
// Явний префікс вмикає сервіс одразу. Висновок моделі вмикає одразу лише сервіси для читання (Сільпо, Cloudflare); Sure і Календар
// (вміють змінювати дані), а також будь-який сумнів моделі, чекають підтвердження кнопкою (ask).
export async function planTask(llm: Llm, repos: KnownRepo[], transcript: string): Promise<TaskPlan> {
	const { task, model: requestedModel, forced } = parsePrefixes(transcript);
	const withRepo = REPO_PREFIX.exec(task);
	const prompt = withRepo ? withRepo[2].trim() : task;
	const route = await routeTask(llm, withRepo ? [] : repos, prompt);
	const repo = withRepo ? withRepo[1] : route.repo;
	const ask: McpName[] = [];
	const mcp: McpFlags = {};
	for (const name of MCP_NAMES) {
		if (forced[name] || (route[name] && !MCP_WRITES.includes(name))) mcp[name] = true;
		else if (route[name] || route.maybe?.includes(name)) ask.push(name);
	}
	// Задачі з даними Sure, Сільпо чи Календаря прості (вибірка й підсумки): за замовчуванням haiku, якщо власник не назвав модель сам.
	// Cloudflare сюди не входить: аналіз витрат і неефективностей потребує міркувань, модель лишається за замовчуванням.
	const model = requestedModel ?? route.model ?? (mcp.sure || mcp.silpo || mcp.calendar || ask.some((n) => n !== "cloudflare") ? "haiku" : undefined);
	return { prompt, route, ...(repo && { repo }), ...(model && { model }), mcp, ask, askRepo: !repo && !!route.unsure };
}
