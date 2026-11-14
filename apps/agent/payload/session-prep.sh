#!/bin/sh
# Готує теку сесії й друкує її шлях: session-prep <назва> [owner/name] (назва — тека й гілка: за змістом задачі або id)
#   без репозиторію: порожня /workspace/sessions/<id>
#   з репозиторієм: спільний клон /workspace/repos/<owner>/<name> (клон або fetch) і worktree /workspace/sessions/<id>
#   в окремій гілці agent/<назва> від свіжої default-гілки
# Ідемпотентний: повторний виклик з тими самими аргументами нічого не ламає й друкує той самий шлях.
set -eu
id=$1
repo=${2:-}
dir=/workspace/sessions/$id

. /usr/local/lib/git-auth.sh

# Секундомір: «timing fetch=…ms …» у stderr (воркер виносить цей рядок у логи; решта stderr — шум git/npm).
now() { date +%s%N | cut -b1-13; }
t0=$(now)
timing=""
mark() { t1=$(now); timing="$timing $1=$((t1 - t0))ms"; t0=$t1; }

if [ -z "$repo" ]; then
	mkdir -p "$dir"
	echo "$dir"
	exit 0
fi

# Worktree вже є (повторний виклик або відновлення зі знімка): нічого не робимо.
if [ -e "$dir/.git" ]; then
	echo "$dir"
	exit 0
fi

base=/workspace/repos/$repo
if [ -d "$base/.git" ]; then
	git -C "$base" fetch --prune origin >&2
else
	mkdir -p "$(dirname "$base")"
	git clone "https://github.com/$repo.git" "$base" >&2
fi
mark fetch

default=$(git -C "$base" symbolic-ref --short refs/remotes/origin/HEAD)
mkdir -p "$(dirname "$dir")"
if git -C "$base" show-ref --verify --quiet "refs/heads/agent/$id"; then
	git -C "$base" worktree add "$dir" "agent/$id" >&2 # гілка лишилась від попередньої спроби: не скидаємо її
else
	git -C "$base" worktree add --no-track -b "agent/$id" "$dir" "$default" >&2
fi

mark worktree

# Залежності проєкту: лише для нового worktree і лише якщо є package.json. Збій встановлення не зупиняє сесію (агент побачить і розбереться).
# `npm ci` на моно-репо займав 30–50 с на кожну нову сесію, тож node_modules будуємо раз на версію package-lock.json
# (/workspace/.deps-cache/<репо>/<хеш>) і кладемо в worktree жорсткими посиланнями (cp -al): секунда замість півхвилини.
# Без lock-файлу кешу немає (результат не відтворюваний). Кеш лежить на тому ж диску, що й worktree, тож посилання можливі;
# коли ні (чи копіювання не вдалось), ставимо як раніше.
install_deps() {
	if [ -f package-lock.json ]; then install="npm ci"; else install="npm install"; fi
	$install --no-audit --no-fund >&2
}
if [ -f "$dir/package.json" ]; then
	cd "$dir"
	if [ -f package-lock.json ]; then
		cache=/workspace/.deps-cache/$repo/$(sha256sum package-lock.json | cut -c1-16)
		if [ -d "$cache/node_modules" ] && cp -al "$cache/node_modules" node_modules 2>/dev/null; then
			echo "залежності з кешу $cache" >&2
			mark deps-cached
		else
			rm -rf node_modules
			if install_deps; then
				# Кеш оновлюємо лише після успішної установки; старі версії lock-файлу цього репо видаляємо.
				rm -rf "/workspace/.deps-cache/$repo" && mkdir -p "$cache" && cp -al node_modules "$cache/node_modules" 2>/dev/null || rm -rf "$cache"
			else
				echo "не вдалося встановити залежності (npm ci)" >&2
			fi
			mark deps-install
		fi
	else
		install_deps || echo "не вдалося встановити залежності (npm install)" >&2
		mark deps-install
	fi
fi
echo "timing$timing" >&2
echo "$dir"
