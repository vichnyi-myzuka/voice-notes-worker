#!/bin/sh
# Старт сесії: за потреби клонує репозиторій (REPO=owner/name) і запускає OpenCode.
# GITHUB_TOKEN потрібен лише для приватних репозиторіїв і для пушу гілок.
# Скрипт виконується й після відновлення зі знімка диска (теки вже є), тому кожен крок безпечний для повтору.
set -e

git config --global user.name "${GIT_AUTHOR_NAME:-opencode-agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@users.noreply.github.com}"

# Токен лише в середовищі процесу (git читає GIT_CONFIG_*), а не в ~/.gitconfig: диск потрапляє в знімки.
if [ -n "$GITHUB_TOKEN" ]; then
	export GIT_CONFIG_COUNT=1
	export GIT_CONFIG_KEY_0="url.https://x-access-token:${GITHUB_TOKEN}@github.com/.insteadOf"
	export GIT_CONFIG_VALUE_0="https://github.com/"
fi

if [ -n "$REPO" ]; then
	if [ ! -d /workspace/repo/.git ]; then
		git clone "https://github.com/${REPO}.git" /workspace/repo
	fi
	cd /workspace/repo
fi

# V2: веб-інтерфейс віддає сам сервер; пароль береться з OPENCODE_PASSWORD.
exec opencode serve --hostname 0.0.0.0 --port 4096
