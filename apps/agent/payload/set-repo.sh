#!/bin/sh
# set-repo <owner/name>: агент повідомляє, що ця сесія працює над репозиторієм (його не визначили на старті).
# Скрипт робить із порожньої теки сесії worktree цього репозиторію на гілці agent/<назва сесії> (як session-prep на старті),
# а воркер бачить цей виклик у потоці подій OpenCode й запам'ятовує репозиторій: від цього працюють кнопки PR, мерж і деплой.
# Запускай одразу на початку, поки в теці сесії немає власних файлів. Ідемпотентний.
set -eu
repo=${1:-}
case "$repo" in
*/*/* | */ | /* | "" | *[!A-Za-z0-9._/-]*)
	echo "usage: set-repo <owner/name>" >&2
	exit 2
	;;
*/*) ;;
*)
	echo "usage: set-repo <owner/name>" >&2
	exit 2
	;;
esac
case "$PWD" in
/workspace/sessions/*) ;;
*)
	echo "set-repo: run it from your session directory (/workspace/sessions/<name>)" >&2
	exit 2
	;;
esac
id=${PWD#/workspace/sessions/}
id=${id%%/*}
if [ -e "/workspace/sessions/$id/.git" ]; then
	echo "/workspace/sessions/$id"
	exit 0
fi
if [ -n "$(ls -A "/workspace/sessions/$id" 2>/dev/null)" ]; then
	echo "set-repo: the session directory is not empty, so it cannot become a worktree. Move your files out, run set-repo again, then move them back." >&2
	exit 1
fi
exec session-prep "$id" "$repo"
