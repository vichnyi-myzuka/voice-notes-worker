#!/bin/sh
# Старт сесії: за потреби клонує репозиторій (REPO=owner/name) і запускає OpenCode.
# GITHUB_TOKEN потрібен лише для приватних репозиторіїв і для пушу гілок.
set -e

git config --global user.name "${GIT_AUTHOR_NAME:-opencode-agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@users.noreply.github.com}"

if [ -n "$GITHUB_TOKEN" ]; then
	git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

if [ -n "$REPO" ]; then
	git clone "https://github.com/${REPO}.git" /workspace/repo
	cd /workspace/repo
fi

exec opencode web --hostname 0.0.0.0 --port 4096
