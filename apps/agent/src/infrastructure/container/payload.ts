import type { Env } from "../../env";
import agents from "../../../payload/AGENTS.md";
import calendarAgent from "../../../payload/calendar-agent.md";
import prePush from "../../../payload/pre-push.sh";
import newReportSite from "../../../payload/new-report-site.sh";
import publish from "../../../payload/publish.sh";
import reportSiteSkill from "../../../payload/report-site-skill.md";
import sessionPrep from "../../../payload/session-prep.sh";
import silpoAgent from "../../../payload/silpo-agent.md";
import sureAgent from "../../../payload/sure-agent.md";
import { CALENDAR_MCP_URL } from "./calendar";
import { SILPO_MCP_URL } from "./silpo";

// Файли, які воркер розкладає в контейнер сам (а не кладе в образ): вони змінюються часто, і від цього не мають скидатися знімки
// та історія сесій. Нові сесії одразу працюють з актуальними версіями; старі сесії зберігають своє.
export type PayloadFile = { path: string; mode: string; content: string };

// Ліміт контексту сесії: модель бачить вікно в 272k токенів, тож автостиснення (AutoCompact) спрацьовує, коли розмова
// впирається в нього, а не у велике рідне вікно моделі. Для всіх моделей провайдера Claude Agent (CLAUDE_MODEL і /model).
export const CONTEXT_LIMIT = 272_000;
const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "fable"];
export const GLOBAL_CONFIG = JSON.stringify(
	{
		$schema: "https://opencode.ai/config.json",
		compaction: { auto: true },
		providers: {
			"claude-agent": {
				models: Object.fromEntries(CLAUDE_MODELS.map((id) => [id, { limit: { context: CONTEXT_LIMIT, output: 32_000 } }])),
			},
		},
	},
	null,
	2,
);

export const PAYLOAD: PayloadFile[] = [
	// Глобальний конфіг OpenCode (ліміт контексту й автостиснення для всіх сесій); конфіг теки сесії (MCP) накладається зверху.
	{ path: "/root/.config/opencode/opencode.json", mode: "644", content: GLOBAL_CONFIG },
	// Глобальні інструкції: OpenCode читає ~/.config/opencode/AGENTS.md, claude (провайдер Claude Agent) — ~/.claude/CLAUDE.md.
	{ path: "/root/.config/opencode/AGENTS.md", mode: "644", content: agents },
	{ path: "/root/.claude/CLAUDE.md", mode: "644", content: agents },
	{ path: "/usr/local/bin/publish", mode: "755", content: publish },
	{ path: "/usr/local/bin/new-report-site", mode: "755", content: newReportSite },
	// Скіл для сайтів-звітів: агент підхоплює його сам за description. OpenCode читає ~/.config/opencode/skills, claude — ~/.claude/skills.
	{ path: "/root/.config/opencode/skills/report-site/SKILL.md", mode: "644", content: reportSiteSkill },
	{ path: "/root/.claude/skills/report-site/SKILL.md", mode: "644", content: reportSiteSkill },
	{ path: "/usr/local/bin/session-prep", mode: "755", content: sessionPrep },
	// Запобіжник: пуш у main/master відхиляється (core.hooksPath задано в образі)
	{ path: "/usr/local/lib/git-hooks/pre-push", mode: "755", content: prePush },
];

// Відбиток вмісту: за ним видно, чи контейнер уже має актуальні файли.
export const PAYLOAD_HASH = (() => {
	let h = 0x811c9dc5;
	for (const c of JSON.stringify(PAYLOAD)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
	return (h >>> 0).toString(16);
})();

// Скрипт для `node -e` у контейнері: пише файли з PAYLOAD (JSON у змінній середовища) і ставить права. Node є в образі.
export const WRITER = `const fs=require("fs"),path=require("path");for(const f of JSON.parse(process.env.PAYLOAD)){fs.mkdirSync(path.dirname(f.path),{recursive:true});fs.writeFileSync(f.path,f.content);fs.chmodSync(f.path,parseInt(f.mode,8))}`;

// MCP-сервери, які сесії підключає власник (див. prepare у computer.ts): sure — фінанси, silpo — покупки в Сільпо, calendar — Google Calendar.
// silpo і calendar — короткі access-токени (їх видають Silpo.accessToken і Calendar.accessToken); без токена сервер не підключається.
export type McpWanted = { sure?: boolean; silpo?: string; calendar?: string };

// Конфіг OpenCode з MCP-серверами для теки однієї сесії: лише для запитаних серверів і лише якщо вони налаштовані (Sure: адреса й токен).
// Секрети Sure не потрапляють у файл: там посилання `{env:…}`, самі змінні передає containerEnv; заголовки Cloudflare Access (Service Token)
// потрібні, коли сервер за тунелем з Access. Токен Сільпо короткий і змінюється, тому лежить у файлі (права 600, з git виключений).
// Основним стає агент під задачу: `sure`, `silpo`, `calendar` або `finance` (Sure і Сільпо разом: зіставляти чеки з платежами);
// будь-яке інше поєднання (напр. календар разом із Sure) — `assistant` з усіма інструкціями.
export function mcpConfig(env: Env, dir: string, want: McpWanted): PayloadFile | undefined {
	const servers: Record<string, unknown> = {};
	if (want.sure && env.SURE_MCP_URL && env.SURE_MCP_TOKEN) {
		const headers: Record<string, string> = { Authorization: "Bearer {env:SURE_MCP_TOKEN}" };
		if (env.SURE_ACCESS_CLIENT_ID && env.SURE_ACCESS_CLIENT_SECRET) {
			headers["CF-Access-Client-Id"] = "{env:SURE_ACCESS_CLIENT_ID}";
			headers["CF-Access-Client-Secret"] = "{env:SURE_ACCESS_CLIENT_SECRET}";
		}
		servers.sure = { type: "remote", url: env.SURE_MCP_URL, oauth: false, headers };
	}
	if (want.silpo) servers.silpo = { type: "remote", url: SILPO_MCP_URL, oauth: false, headers: { Authorization: `Bearer ${want.silpo}` } };
	if (want.calendar) servers.calendar = { type: "remote", url: CALENDAR_MCP_URL, oauth: false, headers: { Authorization: `Bearer ${want.calendar}` } };
	const sure = "sure" in servers;
	const silpo = "silpo" in servers;
	const calendar = "calendar" in servers;
	if (!sure && !silpo && !calendar) return undefined;
	const agent =
		sure && silpo && !calendar ? { name: "finance", description: "Аналітик витрат: Sure і чеки Сільпо", system: `${sureAgent}\n\n${silpoAgent}` }
		: sure && !silpo && !calendar ? { name: "sure", description: "Фінансовий аналітик: працює з даними власника в Sure", system: sureAgent }
		: silpo && !sure && !calendar ? { name: "silpo", description: "Аналітик покупок у Сільпо", system: silpoAgent }
		: calendar && !sure && !silpo ? { name: "calendar", description: "Помічник з Google Calendar власника", system: calendarAgent }
		: { name: "assistant", description: "Помічник власника: його дані з підключених сервісів", system: [sure && sureAgent, silpo && silpoAgent, calendar && calendarAgent].filter(Boolean).join("\n\n") };
	const config = {
		$schema: "https://opencode.ai/config.json",
		default_agent: agent.name,
		agents: { [agent.name]: { description: agent.description, mode: "primary", system: agent.system } },
		mcp: { servers },
	};
	return { path: `${dir}/.opencode/opencode.json`, mode: silpo || calendar ? "600" : "644", content: JSON.stringify(config, null, 2) };
}
