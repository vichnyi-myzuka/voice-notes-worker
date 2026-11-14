// Агент повідомляє репозиторій сесії командою `set-repo <owner/name>` (payload/set-repo.sh): воркер бачить її у виклику bash
// у потоці подій OpenCode (як request-mcp) і запам'ятовує репозиторій, щоб PR, мерж і деплой гілки agent/<назва> знаходили сесію.
const SET_REPO = /(?:^|[\s;&|(])set-repo\s+["']?([\w.-]+\/[\w.-]+)["']?(?![\w./-])/;

// owner/name із виклику інструмента bash (input.command) чи undefined, якщо це інша команда.
export function settedRepo(input: Record<string, unknown> | undefined): string | undefined {
	const command = typeof input?.command === "string" ? input.command : "";
	return SET_REPO.exec(command)?.[1];
}
