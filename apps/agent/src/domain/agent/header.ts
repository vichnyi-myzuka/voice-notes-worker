import { folderFor } from "./folder";
import { MCP_LABELS, MCP_NAMES, type McpFlags } from "./mcp";

// Шапка поста сесії складається з блоку налаштувань (репозиторій, гілка, модель, сервіси) і решти тексту.
// Налаштування можуть змінитись уже після старту (set-repo, /model), тому решту тримаємо окремо, щоб перебудувати шапку.
// lead: текст перед блоком; inline: рядки одразу під блоком (без порожнього рядка); tail: текст після блоку.
export type HeaderParts = { lead?: string; inline?: string; tail?: string };

export type Settings = { repo?: string; folder?: string; model?: string } & McpFlags;

// Блок налаштувань: репозиторій і гілка (лише в сесії з репозиторієм), модель, підключені сервіси.
export function settingsBlock(s: Settings): string {
	return [s.repo ? `📦 ${s.repo}\n🌿 agent/${s.folder}` : "", s.model ? `🤖 ${s.model}` : "", ...MCP_NAMES.filter((name) => s[name]).map((name) => MCP_LABELS[name])].filter(Boolean).join("\n");
}

// Складає шапку з частин і блоку налаштувань.
export function renderHeader(parts: HeaderParts, s: Settings): string {
	return [parts.lead, [settingsBlock(s), parts.inline].filter(Boolean).join("\n"), parts.tail].filter(Boolean).join("\n\n").trim();
}

// Налаштування нової сесії, ще до збереження Tracked (тека виводиться з id і назви).
export const launchSettings = (id: string, s: { repo?: string; name?: string; model?: string } & McpFlags): Settings => ({ ...s, folder: folderFor(id, s.name) });
