# Сайт документації (`apps/docs`)

Приватний сайт `docs.<BASE_DOMAIN>` з актуальним знімком архітектури бота й агента: діаграми (Mermaid), описи з `docs/`, `README.md`, `GLOSSARY.md`, `AGENTS.md`, ADR, а також згенерований «Знімок коду» (модулі кожного застосунку, прив'язки `wrangler.toml`, останні мержі). Сайт перебудовується після кожного мержу в `main`.

## Як це працює

- `npm run build -w apps/docs` (`build/index.ts`) збирає `apps/docs/dist` зі статичних HTML: Markdown рендерить `marked`, відносні посилання між файлами стають посиланнями між сторінками, посилання на код ведуть на GitHub. Діаграми — блоки ` ```mermaid ` у Markdown; браузер малює їх з CDN (`mermaid@11`), тема світла чи темна за системою.
- Головна сторінка — [`architecture.md`](architecture.md): тут редагуй діаграми. «Знімок коду» генерується з файлової системи й `git log`, руками його не правимо.
- Воркер `apps/docs` лише віддає `dist` (Workers Static Assets) і сам перевіряє JWT Cloudflare Access (`verifyAccess`), як `apps/sites`. Без `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` відповідає `503`.
- Локально: `npm run dev -w apps/docs` (збірка + `wrangler dev` без перевірки Access).

## Налаштування (робить власник, один раз)

1. **Access**: Zero Trust → Access → Applications → Self-hosted, hostname `docs.<BASE_DOMAIN>`, політика **Allow** лише твоя пошта. Запиши AUD.
2. **Секрети воркера** (після першого деплою, з `apps/docs`): `npx wrangler secret put ACCESS_AUD` і `ACCESS_TEAM_DOMAIN` (той самий team domain, що в `sites`).
3. **Workflow** (агент не має права змінювати `.github/`): внеси в `.github/workflows/deploy.yml` одну задачу, яка розгортає `docs` після кожного мержу в `main` (без умови `changed`: сайт залежить від усього репозиторію):

```yaml
  deploy-docs:
    needs: [check]
    uses: ./.github/workflows/deploy-app.yml
    with:
      app: docs
      environment: production
    secrets: inherit
```

   `deploy-app.yml` сам підставить `--domain docs.<BASE_DOMAIN>` і виконає `npm run deploy -w apps/docs` (збірка + `wrangler deploy`). Для ручного запуску додай `docs` у опис `apps` (необов'язково).
4. Токен Cloudflare в environment `production` вже має право на Workers Scripts і маршрути зони; нових прав сайт не потребує.
