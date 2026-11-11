# Образ сесії агента: OpenCode (веб-інтерфейс + API) і git для роботи з репозиторієм.
FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl openssh-client \
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

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
