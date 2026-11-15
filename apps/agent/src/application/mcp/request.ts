import { MCP_NAMES, type McpName } from "../../domain/agent";

// Агент просить MCP командою `request-mcp <сервіс>` (payload/request-mcp.sh): воркер бачить її у виклику bash у потоці подій OpenCode.
const REQUEST = new RegExp(`(?:^|[\\s;&|(])request-mcp\\s+(${MCP_NAMES.join("|")})(?![\\w-])`);

// Сервіс із виклику інструмента bash (input.command) чи undefined, якщо це інша команда.
export function requestedMcp(input: Record<string, unknown> | undefined): McpName | undefined {
	const command = typeof input?.command === "string" ? input.command : "";
	return REQUEST.exec(command)?.[1] as McpName | undefined;
}
