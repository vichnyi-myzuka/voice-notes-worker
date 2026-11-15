#!/bin/sh
# handoff [--repo <owner/name|none>] [--name <kebab-case>] <<'EOF' ... EOF: агент передає роботу в НОВУ окрему сесію.
# Текст задачі читається зі stdin (heredoc). Сам скрипт сесії не створює: воркер бачить цей виклик у потоці подій OpenCode
# (у тексті команди є й heredoc), створює в чаті нову тему з постом і запускає там нову сесію з цією задачею.
# --repo: репозиторій нової сесії (за замовчуванням той самий, що й у цієї; none — без репозиторію).
# --name: коротка назва для теки й гілки (kebab-case латиницею).
set -eu
usage() {
	echo "usage: handoff [--repo <owner/name|none>] [--name <kebab-case>] <<'EOF' (task text) EOF" >&2
	exit 2
}
while [ $# -gt 0 ]; do
	case "$1" in
	--repo | --name)
		[ $# -ge 2 ] || usage
		shift 2
		;;
	--repo=* | --name=*) shift ;;
	*) usage ;;
	esac
done
if [ -t 0 ]; then
	usage
fi
if [ -z "$(tr -d '[:space:]' | head -c 1)" ]; then
	echo "handoff: the task text on stdin is empty" >&2
	exit 2
fi
echo "Handoff submitted: the worker is starting a new separate session with this task and posts it in the chat. Do NOT do that work in this session. Mention in one sentence that you handed it off, then continue with your own task (or finish if there is nothing else)."
