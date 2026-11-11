#!/bin/sh
# Швидкий вхід у контейнер агента: `npm run ssh -w apps/agent` (можна додати команду: `npm run ssh -w apps/agent -- ls /workspace`).
# Сам знаходить застосунок і інстанс `main`; контейнер має працювати (SSH його не будить): відкрий `/` у браузері.
set -eu
cd "$(dirname "$0")/.."

if ! ssh-add -l >/dev/null 2>&1; then
	echo "ssh-agent порожній: ключ із паролем не спрацює. Виконай: ssh-add --apple-use-keychain ~/.ssh/id_ed25519" >&2
fi

app=$(npx --no-install wrangler containers list --json | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")).find((c)=>c.name.endsWith("agentsession")); if(!a) process.exit(1); console.log(a.id)')
instance=$(npx --no-install wrangler containers instances "$app" --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8")); const a=Array.isArray(l)?l:(l.instances??l.items??[]); const i=a.find((x)=>x.name==="main"); if(!i) process.exit(1); console.log(i.id)')

if [ $# -gt 0 ]; then
	exec npx --no-install wrangler containers ssh "$instance" --tty -- "$@"
fi
exec npx --no-install wrangler containers ssh "$instance"
