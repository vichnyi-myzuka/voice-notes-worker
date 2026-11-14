#!/bin/sh
# request-mcp <sure|silpo|calendar|cloudflare>: агент просить власника підключити MCP до цієї сесії.
# Сам скрипт нічого не підключає: воркер бачить цей виклик у потоці подій OpenCode, шле власникові в чат кнопки
# «Підключити / Ні», а після відповіді дописує сервер у конфіг сесії й повідомляє про це агента окремим повідомленням.
case "${1:-}" in
sure | silpo | calendar | cloudflare) ;;
*)
	echo "usage: request-mcp <sure|silpo|calendar|cloudflare>" >&2
	exit 2
	;;
esac
echo "The owner has been asked to connect the $1 MCP. End this turn now: reply with one short sentence that you are waiting for the connection, and make no more tool calls. Do not guess or invent data. When the owner decides, you will get a new message: if it is approved, the $1_ tools are available from then on."
