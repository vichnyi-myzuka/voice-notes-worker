#!/bin/sh
# Публікація статичного сайту: `publish <тека> <назва>` (синхронізує теку з бакетом, зайві файли на сайті видаляються),
# `publish --list`, `publish --delete <назва>`. Сайт з'являється на $SITES_BASE_URL/<назва>/ (за Cloudflare Access, бачить лише власник).
# Токен R2 лише на один бакет; ключів Cloudflare для деплою воркерів тут немає, динамічні бекенди не підтримуються.
set -eu

BUCKET="${SITES_BUCKET:-agent-sites}"
MAX_KB=51200 # 50 МБ на сайт
MAX_FILES=1000
usage() { echo "usage: publish <dir> <name> | publish --list | publish --delete <name>" >&2; exit 2; }

for v in R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT SITES_BASE_URL; do
	eval "[ -n \"\${$v:-}\" ]" || { echo "publish: $v is not set (publishing is not configured)" >&2; exit 1; }
done
# rclone без файла конфігурації: віддалене сховище `sites` описується змінними
export RCLONE_CONFIG_SITES_TYPE=s3 RCLONE_CONFIG_SITES_PROVIDER=Cloudflare RCLONE_CONFIG_SITES_ENDPOINT="$R2_ENDPOINT" \
	RCLONE_CONFIG_SITES_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_SITES_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
	RCLONE_CONFIG_SITES_NO_CHECK_BUCKET=true

valid_name() { printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9-]{1,39}$'; }

case "${1:-}" in
	--list)
		rclone lsf --dirs-only "sites:$BUCKET" | sed 's#/$##'
		;;
	--delete)
		[ $# -eq 2 ] || usage
		valid_name "$2" || { echo "publish: bad name '$2' (a-z, 0-9, '-', 2-40 chars)" >&2; exit 2; }
		rclone purge "sites:$BUCKET/$2"
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
		echo "$SITES_BASE_URL/$name/"
		;;
esac
