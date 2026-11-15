# Вебхуки Telegram і GitHub стоять повз Cloudflare Access

**Рішення.** Усе, що в `apps/agent` відкрите людині, закрите Cloudflare Access. Винятки — `/telegram`, `/github`, `/shortcut` і `/managed/*` (вебхуки керованих ботів, PoC; секрет виводиться з `TG_WEBHOOK_SECRET` для кожного бота): сервіси не проходять логін, тому захист там власний.

**Чому/як.**
- Telegram: секретний заголовок `x-telegram-bot-api-secret-token` (порівняння через `safeEqual`), далі дозволені лише канал `CHAT_ID` і особистий чат `TG_OWNER_ID`; кнопки натискає лише власник.
- GitHub: підпис `X-Hub-Signature-256` (HMAC-SHA256 за `GITHUB_WEBHOOK_SECRET`).
- Shortcut (`/shortcut`): секрет у заголовку `x-secret` (`SHORTCUT_SECRET`, `safeEqual`); сесія створюється лише в чаті власника `TG_OWNER_ID`.
- Обидва вебхуки одразу відповідають `200`, а робота йде у фоні (`waitUntil`).
