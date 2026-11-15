import type { McpEnv } from "../../env";
import agents from "../../../payload/AGENTS.md";
import calendarAgent from "../../../payload/calendar-agent.md";
import prePush from "../../../payload/pre-push.sh";
import newReportSite from "../../../payload/new-report-site.sh";
import publish from "../../../payload/publish.sh";
import requestMcp from "../../../payload/request-mcp.sh";
import setRepo from "../../../payload/set-repo.sh";
import reportSiteSkill from "../../../payload/report-site-skill.md";
import grillMeSkill from "../../../payload/skills/grill-me.md";
import tddSkill from "../../../payload/skills/tdd.md";
import diagnoseSkill from "../../../payload/skills/diagnose.md";
import sessionPrep from "../../../payload/session-prep.sh";
import silpoAgent from "../../../payload/silpo-agent.md";
import cloudflareAgent from "../../../payload/cloudflare-agent.md";
import sureAgent from "../../../payload/sure-agent.md";
import { MCP_NAMES, type McpName, type OAuthMcpName } from "../../domain/agent";
import type { OAuthToken } from "@voice-notes/oauth";
import { CLOUDFLARE_MCP_URL, SILPO_MCP_URL } from "./logins";
import { REPORT_SITE_FILES } from "./report-site";

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

const WORKFLOW_SKILLS: [string, string][] = [["grill-me", grillMeSkill], ["tdd", tddSkill], ["diagnose", diagnoseSkill]];

export const PAYLOAD: PayloadFile[] = [
	// Глобальний конфіг OpenCode (ліміт контексту й автостиснення для всіх сесій); конфіг теки сесії (MCP) накладається зверху.
	{ path: "/root/.config/opencode/opencode.json", mode: "644", content: GLOBAL_CONFIG },
	// Глобальні інструкції: OpenCode читає ~/.config/opencode/AGENTS.md, claude (провайдер Claude Agent) — ~/.claude/CLAUDE.md.
	{ path: "/root/.config/opencode/AGENTS.md", mode: "644", content: agents },
	{ path: "/root/.claude/CLAUDE.md", mode: "644", content: agents },
	{ path: "/usr/local/bin/publish", mode: "755", content: publish },
	{ path: "/usr/local/bin/new-report-site", mode: "755", content: newReportSite },
	// Файли шаблону, які копіює new-report-site (див. report-site.ts)
	...REPORT_SITE_FILES,
	// Запит агента на підключення MCP посеред сесії (див. request-mcp.sh і requestedMcp у mcp.ts)
	{ path: "/usr/local/bin/request-mcp", mode: "755", content: requestMcp },
	// Агент повідомляє репозиторій сесії, не визначений на старті (див. set-repo.sh і settedRepo у repo.ts)
	{ path: "/usr/local/bin/set-repo", mode: "755", content: setRepo },
	// Скіл для сайтів-звітів: агент підхоплює його сам за description. OpenCode читає ~/.config/opencode/skills, claude — ~/.claude/skills.
	{ path: "/root/.config/opencode/skills/report-site/SKILL.md", mode: "644", content: reportSiteSkill },
	{ path: "/root/.claude/skills/report-site/SKILL.md", mode: "644", content: reportSiteSkill },
	// Скіли робочого процесу (grill-me, tdd, diagnose): згадані в розділі Approach в AGENTS.md, решта підхоплюється за description.
	...WORKFLOW_SKILLS.flatMap(([name, content]) => [
		{ path: `/root/.config/opencode/skills/${name}/SKILL.md`, mode: "644", content },
		{ path: `/root/.claude/skills/${name}/SKILL.md`, mode: "644", content },
	]),
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

// MCP-сервери, які сесії підключає власник (див. prepare у computer.ts), за реєстром MCP_SERVICES: sure — токен у секретах воркера
// (true), решта — короткі access-токени (їх видає OAuthLogin.accessToken); без токена сервер не підключається.
export type McpWanted = { sure?: boolean } & Partial<Record<OAuthMcpName, OAuthToken>>;

// Google Calendar: готовий відкритий MCP-сервер (nspady/google-calendar-mcp, MIT), який OpenCode запускає в контейнері по stdio.
// Версія збігається з ARG CALENDAR_MCP_VERSION в container/Dockerfile; у образі пакет уже встановлено, а в старому (знімок до оновлення
// образу) сервер тягнеться через npx. Вхід у Google робить воркер (logins.ts): сервер отримує лише access-токен у `tokens.json`
// і заглушку замість client id/secret (без refresh-токена він сам нічого не оновлює). `manage-accounts` вимкнено: входом керує воркер.
export const CALENDAR_MCP_VERSION = "2.8.1";
const CALENDAR_TOOLS = "list-calendars,list-events,search-events,get-event,list-colors,create-event,create-events,update-event,delete-event,get-freebusy,get-current-time,respond-to-event";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

function calendarFiles(dir: string, token: OAuthToken): { server: unknown; files: PayloadFile[] } {
	const base = `${dir}/.opencode/calendar`;
	const keys = { installed: { client_id: "managed-by-worker", client_secret: "unused", redirect_uris: ["http://localhost:3000/oauth2callback"] } };
	const tokens = { normal: { access_token: token.access, token_type: "Bearer", scope: CALENDAR_SCOPE, expiry_date: token.expiresAt } };
	return {
		server: {
			type: "local",
			command: ["sh", "-c", `command -v google-calendar-mcp >/dev/null && exec google-calendar-mcp || exec npx -y @cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}`],
			environment: { GOOGLE_OAUTH_CREDENTIALS: `${base}/gcp-oauth.keys.json`, GOOGLE_CALENDAR_MCP_TOKEN_PATH: `${base}/tokens.json`, ENABLED_TOOLS: CALENDAR_TOOLS },
		},
		files: [
			{ path: `${base}/gcp-oauth.keys.json`, mode: "600", content: JSON.stringify(keys, null, 2) },
			{ path: `${base}/tokens.json`, mode: "600", content: JSON.stringify(tokens, null, 2) },
		],
	};
}

// Як сервіс потрапляє в конфіг OpenCode і в інструкції агента. Запис на кожен сервіс реєстру: пропуск не збереться.
type McpServer = {
	// Інструкції агента для сервісу: їх отримує й сесія, до якої сервіс підключили посеред роботи (агент сесії вже вибраний і не міняється).
	prompt: string;
	// Опис агента, коли сервіс єдиний у сесії.
	description: string;
	// Адреса віддаленого сервера з коротким токеном: токен лежить у конфігу теки (права 600) і його треба оновлювати в запущеному
	// OpenCode (файл він наживо не перечитує).
	remote?: string;
	// Запис сервера (і файли поруч); undefined — сервіс не налаштований чи токена немає.
	server(env: McpEnv, dir: string, want: McpWanted): { server: unknown; files?: PayloadFile[] } | undefined;
};

// Запис віддаленого сервера з коротким токеном (спільний для файлу конфігу й для PUT /api/experimental/mcp/{name} у живий OpenCode).
export const remoteMcp = (url: string, token: string) => ({ type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${token}` } });

// Секрети Sure не потрапляють у файл: там посилання `{env:…}`, самі змінні передає containerEnv; заголовки Cloudflare Access (Service Token)
// потрібні, коли сервер за тунелем з Access. Токени Сільпо й Cloudflare короткі й змінюються, тому лежать у файлі (права 600, з git виключений).
const MCP_SERVERS: Record<McpName, McpServer> = {
	sure: {
		prompt: sureAgent,
		description: "Фінансовий аналітик: працює з даними власника в Sure",
		server(env, _dir, want) {
			if (!(want.sure && env.SURE_MCP_URL && env.SURE_MCP_TOKEN)) return undefined;
			const headers: Record<string, string> = { Authorization: "Bearer {env:SURE_MCP_TOKEN}" };
			if (env.SURE_ACCESS_CLIENT_ID && env.SURE_ACCESS_CLIENT_SECRET) {
				headers["CF-Access-Client-Id"] = "{env:SURE_ACCESS_CLIENT_ID}";
				headers["CF-Access-Client-Secret"] = "{env:SURE_ACCESS_CLIENT_SECRET}";
			}
			return { server: { type: "remote", url: env.SURE_MCP_URL, oauth: false, headers } };
		},
	},
	silpo: {
		prompt: silpoAgent,
		description: "Аналітик покупок у Сільпо",
		remote: SILPO_MCP_URL,
		server: (_env, _dir, want) => want.silpo && { server: remoteMcp(SILPO_MCP_URL, want.silpo.access) },
	},
	calendar: {
		prompt: calendarAgent,
		description: "Помічник з Google Calendar власника",
		server: (_env, dir, want) => want.calendar && calendarFiles(dir, want.calendar),
	},
	cloudflare: {
		prompt: cloudflareAgent,
		description: "Помічник з акаунтом Cloudflare власника",
		remote: CLOUDFLARE_MCP_URL,
		server: (_env, _dir, want) => want.cloudflare && { server: remoteMcp(CLOUDFLARE_MCP_URL, want.cloudflare.access) },
	},
};

// Інструкції агента для кожного MCP (див. McpServer.prompt).
export const MCP_PROMPTS = Object.fromEntries(MCP_NAMES.map((name) => [name, MCP_SERVERS[name].prompt])) as Record<McpName, string>;

// Сервіси, чиї короткі токени оновлюються в запущеному OpenCode.
export const REFRESHABLE_MCP = MCP_NAMES.filter((name): name is OAuthMcpName => !!MCP_SERVERS[name].remote);
export const refreshableMcp = (want: McpWanted): Record<string, unknown> =>
	Object.fromEntries(REFRESHABLE_MCP.flatMap((name) => (want[name] ? [[name, remoteMcp(MCP_SERVERS[name].remote!, want[name].access)]] : [])));

// Конфіг OpenCode з MCP-серверами для теки однієї сесії: лише для запитаних серверів і лише якщо вони налаштовані (Sure: адреса й токен).
// Основним стає агент під задачу: `sure`, `silpo`, `calendar`, `cloudflare` або `finance` (Sure і Сільпо разом: зіставляти чеки з платежами);
// будь-яке інше поєднання (напр. календар разом із Sure чи Cloudflare) — `assistant` з усіма інструкціями.
export function mcpConfig(env: McpEnv, dir: string, want: McpWanted): PayloadFile[] | undefined {
	const servers: Record<string, unknown> = {};
	const files: PayloadFile[] = [];
	for (const name of MCP_NAMES) {
		const made = MCP_SERVERS[name].server(env, dir, want);
		if (!made) continue;
		servers[name] = made.server;
		files.push(...(made.files ?? []));
	}
	const on = MCP_NAMES.filter((name) => name in servers);
	if (!on.length) return undefined;
	const names = on.join("+");
	const agent =
		names === "sure+silpo" ? { name: "finance", description: "Аналітик витрат: Sure і чеки Сільпо", system: `${sureAgent}\n\n${silpoAgent}` }
		: on.length === 1 ? { name: on[0], description: MCP_SERVERS[on[0]].description, system: MCP_SERVERS[on[0]].prompt }
		: { name: "assistant", description: "Помічник власника: його дані з підключених сервісів", system: on.map((name) => MCP_SERVERS[name].prompt).join("\n\n") };
	const config = {
		$schema: "https://opencode.ai/config.json",
		default_agent: agent.name,
		agents: { [agent.name]: { description: agent.description, mode: "primary", system: agent.system } },
		mcp: { servers },
	};
	return [{ path: `${dir}/.opencode/opencode.json`, mode: on.some((name) => MCP_SERVERS[name].remote) ? "600" : "644", content: JSON.stringify(config, null, 2) }, ...files];
}
