# Локальний e2e (справжній канал і Todoist!)

```sh
cd apps/notes && npx wrangler dev --port 8787 --var LOCAL_DEV:1 --var TG_OWNER_ID:<твій Telegram id> --var TG_WEBHOOK_SECRET:local-webhook-test --env-file ../../.env
```

- Пост у каналі імітується POST на `localhost:8787/telegram` з заголовком `x-telegram-bot-api-secret-token: local-webhook-test` і тілом `{"channel_post":{"message_id":…,"date":…,"chat":{"id":CHAT_ID,"type":"channel"},"text":"…"}}` (правка — з `"reply_to_message":{"message_id":<id нотатки>}`).
- Помилки «message to react/delete not found» для вигаданих `message_id` — очікувані.
- Кінець обробки — рядок `QUEUE voice-notes` у лозі; id опублікованої нотатки — `published as message N`.
- **Тест створює справжні задачі й повідомлення: завжди прибирай** відповіддю «Видали нотатку» на тестову нотатку.
- Не використовуй назви реальних задач користувача (напр. ліки в Health): тріаж позначить їх дублікатами.
- Перевіряти Todoist можна через `td` CLI або `curl` з `$TODOIST_TOKEN`.
