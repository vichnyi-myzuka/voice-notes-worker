# Образ сесії агента: OpenCode (веб-інтерфейс + API) і git для роботи з репозиторієм.
FROM --platform=linux/amd64 node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl openssh-client \
	&& rm -rf /var/lib/apt/lists/*
# Лише OpenCode V2 (пакет @opencode/cli); версію зафіксовано, щоб образ збирався відтворювано.
ARG OPENCODE_VERSION=2.2.7
RUN npm install -g @opencode/cli@${OPENCODE_VERSION}

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
