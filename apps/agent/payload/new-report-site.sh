#!/bin/sh
# Створює стартовий проєкт звіту (Vite + React + Tailwind 4 + shadcn-стиль + Recharts) і ставить залежності:
#   new-report-site <тека>
# Файли шаблону лежать у /usr/local/share/report-site (їх розкладає воркер з payload/report-site/, див. report-site.ts).
# Далі: правиш src/data.ts і src/App.tsx, `npm run build`, `publish dist <назва>`. Правила: скіл report-site.
set -eu
dir=${1:?"використання: new-report-site <тека>"}
template=/usr/local/share/report-site
if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
	echo "тека $dir не порожня" >&2
	exit 1
fi
mkdir -p "$dir"
cp -R "$template/." "$dir/"
cd "$dir"
printf 'node_modules\ndist\n' > .gitignore
npm install --no-audit --no-fund --loglevel=error
echo "Готово: $(pwd). Далі правиш src/data.ts і src/App.tsx, потім npm run build."
