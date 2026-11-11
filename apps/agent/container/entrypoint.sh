#!/bin/sh
# Старт сесії: за потреби клонує репозиторій (REPO=owner/name) і запускає OpenCode.
# GITHUB_TOKEN потрібен лише для приватних репозиторіїв і для пушу гілок.
# Скрипт виконується й після відновлення зі знімка диска (теки вже є), тому кожен крок безпечний для повтору.
set -e

git config --global user.name "${GIT_AUTHOR_NAME:-opencode-agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@users.noreply.github.com}"

# Токен лише в середовищі процесу: credential helper віддає його git за запитом. На диск (знімки) він не потрапляє,
# а в URL remote його немає, тому `git remote -v` його не друкує (на відміну від url.insteadOf).
if [ -n "$GITHUB_TOKEN" ]; then
	export GIT_CONFIG_COUNT=1
	export GIT_CONFIG_KEY_0="credential.https://github.com.helper"
	export GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
fi

if [ -n "$REPO" ]; then
	if [ ! -d /workspace/repo/.git ]; then
		git clone "https://github.com/${REPO}.git" /workspace/repo
	fi
	cd /workspace/repo
fi

# V2: веб-інтерфейс віддає сам сервер; пароль береться з OPENCODE_PASSWORD.
exec opencode serve --hostname 0.0.0.0 --port 4096
