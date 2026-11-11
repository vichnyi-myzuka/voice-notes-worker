#!/bin/sh
# Старт контейнера: запускає OpenCode, спільний для всіх сесій. GITHUB_TOKEN потрібен для приватних репозиторіїв і пушу гілок.
# Скрипт виконується й після відновлення зі знімка диска (теки вже є), тому кожен крок безпечний для повтору.
set -e

git config --global user.name "${GIT_AUTHOR_NAME:-opencode-agent}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent@users.noreply.github.com}"

. /usr/local/lib/git-auth.sh

# Репозиторії клонує й готує worktree-и session-prep (його викликає Durable Object через exec для кожної сесії).
mkdir -p /workspace/sessions /workspace/repos
cd /workspace

# V2: веб-інтерфейс віддає сам сервер; пароль береться з OPENCODE_PASSWORD.
exec opencode serve --hostname 0.0.0.0 --port 4096
