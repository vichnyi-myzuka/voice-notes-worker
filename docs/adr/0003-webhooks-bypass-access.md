# Вебхуки Telegram і GitHub стоять повз Cloudflare Access

**Рішення.** Усе, що в `apps/agent` відкрите людині, закрите Cloudflare Access. Винятки — `/telegram` і `/github`: сервіси не проходять логін, тому захист там власний. API розкладів для агента в контейнері (`/agent-api/*`, ADR 0005) повз Access **не** йде: контейнер проходить його сервісним токеном (див. нижче).

**Чому/як.**
- Telegram: секретний заголовок `x-telegram-bot-api-secret-token` (порівняння через `safeEqual`), далі дозволені лише канал `CHAT_ID` і особистий чат `TG_OWNER_ID`; кнопки натискає лише власник.
- GitHub: підпис `X-Hub-Signature-256` (HMAC-SHA256 за `GITHUB_WEBHOOK_SECRET`).
- Обидва вебхуки одразу відповідають `200`, а робота йде у фоні (`waitUntil`).
- `/agent-api/schedules` (не виняток): лишається за Access, контейнер іде з Service Token (`CF-Access-Client-Id/Secret`, секрети воркера `AGENT_API_ACCESS_CLIENT_ID/SECRET`), воркер перевіряє JWT Access (`verifyAccess`). Поверх цього секрет сесії `Authorization: Bearer` (HMAC від назви теки сесії на `OPENCODE_PASSWORD`, `safeEqual`) і заголовок `x-session-folder`. Агент лише пропонує: розклади й зміни від нього стають `pending` до підтвердження власником у Telegram. Той самий підхід, що для MCP Sure (`SURE_ACCESS_CLIENT_ID/SECRET`). Політика Service Auth створюється в окремому застосунку Access на шлях `agent-api` (його AUD — `AGENT_API_ACCESS_AUD`), тож токен не відкриває решту хоста агента.
