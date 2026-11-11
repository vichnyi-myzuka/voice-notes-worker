# Образ сесії агента: OpenCode (веб-інтерфейс + API) і git для роботи з репозиторієм.
FROM --platform=linux/amd64 node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl openssh-client \
	&& rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/entrypoint.sh"]
