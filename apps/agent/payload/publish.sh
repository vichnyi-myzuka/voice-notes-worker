#!/bin/sh
# Публікація статичного сайту: `publish <тека> <назва>` (синхронізує теку з бакетом, зайві файли на сайті видаляються),
# `publish --list`, `publish --delete <назва>`. Сайт з'являється на $SITES_BASE_URL/<назва>/ (за Cloudflare Access, бачить лише власник).
# З `--public` першим аргументом (`publish --public <тека> <назва>`, `publish --public --list|--delete …`) сайт іде в окремий публічний
# бакет і відкривається без входу на $PUBLIC_SITES_BASE_URL/<назва>/. Публічні сайти не належать сесії: /delete їх не видаляє.
# Токен R2 лише на один бакет; ключів Cloudflare для деплою воркерів тут немає, динамічні бекенди не підтримуються.
set -eu

# --public: окремий бакет, окремий ключ R2 (лише на публічний бакет) і окрема адреса
PUBLIC=0
if [ "${1:-}" = --public ]; then
	PUBLIC=1
	shift
fi
if [ "$PUBLIC" = 1 ]; then
	BUCKET="${PUBLIC_SITES_BUCKET:-agent-sites-public}"
	KEY_ID="${PUBLIC_R2_ACCESS_KEY_ID:-}"
	KEY_SECRET="${PUBLIC_R2_SECRET_ACCESS_KEY:-}"
	BASE_URL="${PUBLIC_SITES_BASE_URL:-}"
	REQUIRED="PUBLIC_R2_ACCESS_KEY_ID PUBLIC_R2_SECRET_ACCESS_KEY R2_ENDPOINT PUBLIC_SITES_BASE_URL"
else
	BUCKET="${SITES_BUCKET:-agent-sites}"
	KEY_ID="${R2_ACCESS_KEY_ID:-}"
	KEY_SECRET="${R2_SECRET_ACCESS_KEY:-}"
	BASE_URL="${SITES_BASE_URL:-}"
	REQUIRED="R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT SITES_BASE_URL"
fi
MAX_KB=51200 # 50 МБ на сайт
MAX_FILES=1000
usage() { echo "usage: publish [--public] <dir> <name> | publish [--public] --list | publish [--public] --delete <name>" >&2; exit 2; }

for v in $REQUIRED; do
	eval "[ -n \"\${$v:-}\" ]" || { echo "publish: $v is not set (publishing is not configured)" >&2; exit 1; }
done
# rclone без файла конфігурації: віддалене сховище `sites` описується змінними
export RCLONE_CONFIG_SITES_TYPE=s3 RCLONE_CONFIG_SITES_PROVIDER=Cloudflare RCLONE_CONFIG_SITES_ENDPOINT="$R2_ENDPOINT" \
	RCLONE_CONFIG_SITES_ACCESS_KEY_ID="$KEY_ID" RCLONE_CONFIG_SITES_SECRET_ACCESS_KEY="$KEY_SECRET" \
	RCLONE_CONFIG_SITES_NO_CHECK_BUCKET=true

# Кому належить сайт: сесії, з теки якої його опублікували (cwd у /workspace/sessions/<тека>/...). Список назв лежить у
# /workspace/published/<тека>; /delete сесії за ним видаляє її сайти. Сайт належить одній сесії: перепублікація з іншої її забирає.
PUBLISHED="${PUBLISHED_DIR:-/workspace/published}"
SESSIONS="${SESSIONS_ROOT:-/workspace/sessions}"
session_of() {
	case "$PWD" in
		"$SESSIONS"/*) s=${PWD#"$SESSIONS"/}; printf '%s' "${s%%/*}" ;;
	esac
}
disown() {
	[ "$PUBLIC" = 0 ] || return 0 # публічні сайти ніхто не «володіє»
	[ -d "$PUBLISHED" ] || return 0
	for f in "$PUBLISHED"/*; do
		[ -f "$f" ] || continue
		grep -vxF "$1" "$f" > "$f.tmp" || true
		mv "$f.tmp" "$f"
	done
}
own() {
	[ "$PUBLIC" = 0 ] || return 0
	disown "$1"
	session=$(session_of)
	[ -n "$session" ] || return 0
	mkdir -p "$PUBLISHED"
	echo "$1" >> "$PUBLISHED/$session"
}

valid_name() { printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]{1,39}$'; }

case "${1:-}" in
	--list)
		rclone lsf --dirs-only "sites:$BUCKET" | sed 's#/$##'
		;;
	--delete)
		[ $# -eq 2 ] || usage
		valid_name "$2" || { echo "publish: bad name '$2' (a-z, 0-9, '-', 2-40 chars)" >&2; exit 2; }
		rclone purge "sites:$BUCKET/$2"
		disown "$2"
		echo "deleted $2"
		;;
	"" | -*)
		usage
		;;
	*)
		[ $# -eq 2 ] || usage
		dir="$1"
		name="$2"
		valid_name "$name" || { echo "publish: bad name '$name' (a-z, 0-9, '-', 2-40 chars)" >&2; exit 2; }
		[ -d "$dir" ] || { echo "publish: $dir is not a directory" >&2; exit 2; }
		[ -f "$dir/index.html" ] || { echo "publish: $dir/index.html is missing (it is the site's entry page)" >&2; exit 2; }
		size=$(du -sk "$dir" | cut -f1)
		[ "$size" -le "$MAX_KB" ] || { echo "publish: $dir is ${size} KB, the limit is ${MAX_KB} KB" >&2; exit 2; }
		files=$(find "$dir" -type f | wc -l)
		[ "$files" -le "$MAX_FILES" ] || { echo "publish: $files files, the limit is $MAX_FILES" >&2; exit 2; }
		# Без прихованих файлів (.git, .env), node_modules і завеликих файлів.
		rclone sync "$dir" "sites:$BUCKET/$name" --exclude '.*' --exclude '.*/**' --exclude 'node_modules/**' --max-size 20M >&2
		own "$name"
		echo "$BASE_URL/$name/"
		;;
esac
