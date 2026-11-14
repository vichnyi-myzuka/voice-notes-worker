# Вебхуки Telegram і GitHub стоять повз Cloudflare Access

**Рішення.** Усе, що в `apps/agent` відкрите людині, закрите Cloudflare Access. Винятки — `/telegram`, `/github` і `/agent-api/*` (API розкладів для агента в контейнері, ADR 0005): вони не проходять логін, тому захист там власний.

**Чому/як.**
- Telegram: секретний заголовок `x-telegram-bot-api-secret-token` (порівняння через `safeEqual`), далі дозволені лише канал `CHAT_ID` і особистий чат `TG_OWNER_ID`; кнопки натискає лише власник.
- GitHub: підпис `X-Hub-Signature-256` (HMAC-SHA256 за `GITHUB_WEBHOOK_SECRET`).
- Обидва вебхуки одразу відповідають `200`, а робота йде у фоні (`waitUntil`).
- `/agent-api/schedules`: секрет сесії `Authorization: Bearer` (HMAC від назви теки сесії на `OPENCODE_PASSWORD`, перевіряється через `safeEqual`) і заголовок `x-session-folder`. Агент лише пропонує: розклади й зміни від нього стають `pending` до підтвердження власником у Telegram. Шлях треба окремо виключити з Access у Cloudflare Zero Trust (Bypass для `/agent-api/*`), як `/telegram` і `/github`.
