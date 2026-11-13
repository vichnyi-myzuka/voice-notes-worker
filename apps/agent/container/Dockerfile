# Образ сесії агента: OpenCode (веб-інтерфейс + API) і git для роботи з репозиторієм.
FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl openssh-client rclone \
		python3 python3-pip python3-venv \
	&& rm -rf /var/lib/apt/lists/*
# GitHub CLI з офіційного репозиторію (у Debian bookworm версія застаріла). Авторизація — зі змінної GITHUB_TOKEN.
RUN mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*
# Лише OpenCode V2 (пакет @opencode/cli); версію зафіксовано, щоб образ збирався відтворювано.
ARG OPENCODE_VERSION=2.2.7
# Пакет тягне бінарники всіх платформ (~250 МБ кожен) і кеш npm; postinstall кладе потрібний у bin/opencode.exe
# жорстким посиланням, тож решту видаляємо в тому самому шарі (інакше образ ~1,6 ГБ і пуш у реєстр падає за таймаутом).
RUN npm install -g @opencode/cli@${OPENCODE_VERSION} \
	&& rm -rf /usr/local/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-* \
	&& npm cache clean --force

# Claude Code для провайдера Claude Agent (сесії за підпискою Claude): OpenCode запускає незмінений `claude`.
# Токен підписки приходить зі змінної CLAUDE_CODE_OAUTH_TOKEN (див. README).
ARG CLAUDE_CODE_VERSION=2.1.322
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
	&& npm cache clean --force

# MCP-сервер Google Calendar (https://github.com/nspady/google-calendar-mcp, MIT): сесія запускає його локально (stdio), коли просили Календар.
# Версія збігається з CALENDAR_MCP_VERSION у src/infrastructure/container/payload.ts (там запасний запуск через npx, якщо образ старий).
ARG CALENDAR_MCP_VERSION=2.8.1
RUN npm install -g @cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION} \
	&& npm cache clean --force

COPY entrypoint.sh /entrypoint.sh
COPY git-auth.sh /usr/local/lib/git-auth.sh
# Те, що змінюється часто (AGENTS.md, publish, session-prep, git-хук), в образ не входить: воркер розкладає ці файли сам при
# кожному старті контейнера й після змін (див. payload/ і src/infrastructure/container/payload.ts). Так оновлення інструкцій
# чи команд не потребує нового образу, а образ новим сесіям не потрібен; знімки зі старих образів відновлюються з історією.
RUN mkdir -p /root/.config/opencode /root/.claude /usr/local/lib/git-hooks \
	&& chmod +x /entrypoint.sh \
	&& git config --system core.hooksPath /usr/local/lib/git-hooks

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
