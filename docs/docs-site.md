# Сайт документації (`apps/docs`)

Приватний сайт `docs.<BASE_DOMAIN>` з актуальним знімком архітектури бота й агента: схеми, описи, архітектурні рішення, модулі й прив'язки кожного воркера, останні мержі. Сайт перебудовується після кожного мержу в `main`.

## Як це працює

- Каркас — шаблон `report-site` (Vite + React + Tailwind, компоненти в стилі shadcn/ui), той самий, що в усіх сайтах агента. Код сторінки лежить у `apps/docs/web/`.
- **Схеми** (`web/src/diagrams.tsx`) зібрані вручну з `DiagramCard`, `Box` і `Arrow` (кнопка «На весь екран» дає масштабування й перетягування). Змінилась структура чи потік даних: онови схему в тому ж PR. **Описи** (`web/src/content.ts`) теж пишуться вручну за `docs/`.
- **Дані** генерує `scripts/generate.ts` перед збіркою у `web/src/generated.json` (у git не потрапляє): теки й файли `src` кожного застосунку й пакета, прив'язки з `wrangler.toml`, ADR, перелік документів, останні мержі з `git log`. Тому розділи «Модулі й прив'язки», «Архітектурні рішення» й лічильники завжди відповідають `main`.
- `npm run build -w apps/docs` збирає `apps/docs/dist`. Воркер `apps/docs` (`src/`) віддає його як Workers Static Assets і сам перевіряє JWT Cloudflare Access (`verifyAccess`), як `apps/sites`. Без `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` відповідає `503`.
- Локально: `npm run dev -w apps/docs` (збірка + `wrangler dev` без перевірки Access). Для приватного прев'ю: `npm run build -w apps/docs && publish apps/docs/dist <назва>`.

## Налаштування (робить власник, один раз)

1. **Access**: Zero Trust → Access → Applications → Self-hosted, hostname `docs.<BASE_DOMAIN>`, політика **Allow** лише твоя пошта. Запиши AUD.
2. **Секрети воркера** (після першого деплою, з `apps/docs`): `npx wrangler secret put ACCESS_AUD` і `ACCESS_TEAM_DOMAIN` (той самий team domain, що в `sites`).
3. **Розгортання** робить CI: `deploy-docs` у `.github/workflows/deploy.yml` запускається після кожного мержу в `main` (без умови `changed`: сайт залежить від усього репозиторію). `deploy-app.yml` підставляє `--domain docs.<BASE_DOMAIN>` і виконує `npm run deploy -w apps/docs`; `fetch-depth: 0` потрібен, щоб розділ «Останні мержі» (`git log --merges`) не був порожнім.
4. Токен Cloudflare в environment `production` вже має право на Workers Scripts і маршрути зони; нових прав сайт не потребує.
