import { MCP_NAMES, type McpFlags, type McpName } from "../../domain/agent";

// «owner/name: задача» на початку тексту — репозиторій для сесії.
export const REPO_PREFIX = /^([\w-][\w.-]*\/[\w-][\w.-]*)\s*:\s*([\s\S]+)$/;
// «@opus» (чи «@провайдер/модель») перед усім іншим — модель для нової сесії.
const MODEL_PREFIX = /^@([\w.-]+(?:\/[\w.:-]+)?)\s+([\s\S]+)$/;
// Голосом «@» не продиктуєш: «модель опус, задача» (чи «model opus …») на початку розшифровки. Лише відомі назви, щоб
// звичайна задача на кшталт «модель користувача…» не вважалась вибором моделі.
const SPOKEN_MODELS: Record<string, string> = { opus: "opus", опус: "opus", sonnet: "sonnet", сонет: "sonnet", соннет: "sonnet", haiku: "haiku", хайку: "haiku" };
const SPOKEN_MODEL_PREFIX = /^(?:модель|model)\s+([\p{L}]+)[\s,.:;!—–-]+([\s\S]+)$/iu;

function modelPrefix(transcript: string): { model: string; task: string } | undefined {
	const at = MODEL_PREFIX.exec(transcript);
	if (at) return { model: at[1], task: at[2] };
	const spoken = SPOKEN_MODEL_PREFIX.exec(transcript);
	const model = spoken && SPOKEN_MODELS[spoken[1].toLowerCase()];
	return spoken && model ? { model, task: spoken[2] } : undefined;
}

// Явне ввімкнення MCP: «@sure задача» чи голосом «шур, задача» на початку (так само Сільпо, Календар, Cloudflare). Для Sure без префікса
// його пропонує висновок моделі (routeTask: задача потребує особистих фінансів власника) і вмикає після підтвердження кнопкою, тож слово
// «шур» не обов'язкове; Cloudflare (лише читання) вмикає й роутер.
const MCP_PREFIXES: Record<McpName, RegExp> = {
	sure: /^(?:@sure|shure|шур|шюр|шуре)[\s,.:;!—–-]+([\s\S]+)$/iu,
	silpo: /^(?:@silpo|silpo|сільпо|сильпо|сілпо)[\s,.:;!—–-]+([\s\S]+)$/iu,
	calendar: /^(?:@calendar|calendar|календар|календарю|календаря)[\s,.:;!—–-]+([\s\S]+)$/iu,
	cloudflare: /^(?:@cloudflare|cloudflare|клаудфлер|клауд флер|клаудфлеру|клаудфлера|клаудфлейр|клодфлер)[\s,.:;!—–-]+([\s\S]+)$/iu,
};

// Шукає префікси моделі й сервісів MCP в будь-якому порядку; повертає задачу без них.
export function parsePrefixes(transcript: string): { task: string; model?: string; forced: McpFlags } {
	let task = transcript;
	let model: string | undefined;
	const forced: McpFlags = {};
	for (let i = 0; i < 5; i++) {
		const m = !model && modelPrefix(task);
		if (m) ({ model, task } = m);
		for (const name of MCP_NAMES) {
			const found = !forced[name] && MCP_PREFIXES[name].exec(task);
			if (found) {
				task = found[1];
				forced[name] = true;
			}
		}
	}
	return { task: task.trim(), model, forced };
}
