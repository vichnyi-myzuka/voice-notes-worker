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

default=$(git -C "$base" symbolic-ref --short refs/remotes/origin/HEAD)
mkdir -p "$(dirname "$dir")"
if git -C "$base" show-ref --verify --quiet "refs/heads/agent/$id"; then
	git -C "$base" worktree add "$dir" "agent/$id" >&2 # гілка лишилась від попередньої спроби: не скидаємо її
else
	git -C "$base" worktree add --no-track -b "agent/$id" "$dir" "$default" >&2
fi

# Залежності проєкту: лише для нового worktree і лише якщо є package.json. Збій встановлення не зупиняє сесію (агент побачить і розбереться).
if [ -f "$dir/package.json" ]; then
	if [ -f "$dir/package-lock.json" ]; then install="npm ci"; else install="npm install"; fi
	(cd "$dir" && $install --no-audit --no-fund >&2) || echo "не вдалося встановити залежності ($install)" >&2
fi
echo "$dir"
