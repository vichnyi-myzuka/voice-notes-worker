import type { Env } from "../../env";
import agents from "../../../payload/AGENTS.md";
import prePush from "../../../payload/pre-push.sh";
import newReportSite from "../../../payload/new-report-site.sh";
import publish from "../../../payload/publish.sh";
import reportSiteSkill from "../../../payload/report-site-skill.md";
import sessionPrep from "../../../payload/session-prep.sh";
import silpoAgent from "../../../payload/silpo-agent.md";
import sureAgent from "../../../payload/sure-agent.md";
import { SILPO_MCP_URL } from "./silpo";

// Файли, які воркер розкладає в контейнер сам (а не кладе в образ): вони змінюються часто, і від цього не мають скидатися знімки
// та історія сесій. Нові сесії одразу працюють з актуальними версіями; старі сесії зберігають своє.
export type PayloadFile = { path: string; mode: string; content: string };

export const PAYLOAD: PayloadFile[] = [
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

// MCP-сервери, які сесії підключає власник (див. prepare у computer.ts): sure — фінанси, silpo — покупки в Сільпо.
// silpo — короткий access-токен Сільпо (його видає Silpo.accessToken); без нього Сільпо не підключається.
export type McpWanted = { sure?: boolean; silpo?: string };

// Конфіг OpenCode з MCP-серверами для теки однієї сесії: лише для запитаних серверів і лише якщо вони налаштовані (Sure: адреса й токен).
// Секрети Sure не потрапляють у файл: там посилання `{env:…}`, самі змінні передає containerEnv; заголовки Cloudflare Access (Service Token)
// потрібні, коли сервер за тунелем з Access. Токен Сільпо короткий і змінюється, тому лежить у файлі (права 600, з git виключений).
// Основним стає агент під задачу: `sure`, `silpo` або `finance` (обидва разом: зіставляти чеки з платежами).
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
	const sure = "sure" in servers;
	const silpo = "silpo" in servers;
	if (!sure && !silpo) return undefined;
	const agent =
		sure && silpo ? { name: "finance", description: "Аналітик витрат: Sure і чеки Сільпо", system: `${sureAgent}\n\n${silpoAgent}` }
		: sure ? { name: "sure", description: "Фінансовий аналітик: працює з даними власника в Sure", system: sureAgent }
		: { name: "silpo", description: "Аналітик покупок у Сільпо", system: silpoAgent };
	const config = {
		$schema: "https://opencode.ai/config.json",
		default_agent: agent.name,
		agents: { [agent.name]: { description: agent.description, mode: "primary", system: agent.system } },
		mcp: { servers },
	};
	return { path: `${dir}/.opencode/opencode.json`, mode: silpo ? "600" : "644", content: JSON.stringify(config, null, 2) };
}
