# Cloudflare: моделі, ліміти, витрати

Довідник по платформі. Огляд проєкту — у [README](../README.md).

## Workers AI

Whisper (і резервна Gemma 4) працюють через binding `AI`. Безкоштовна квота: 10 000 neurons на день (і на Free-плані). Whisper коштує ~47 neurons за хвилину аудіо (~200 хв на день безкоштовно), а summary однієї нотатки ~20–50 neurons. Ціни: https://developers.cloudflare.com/workers-ai/platform/pricing/

## Ліміти Cloudflare (звірено з документацією 2026-11-09)

| | Free | Paid ($5/міс) |
|---|---|---|
| Queues | доступні | доступні |
| Операції Queues | 10 000/день | 1 млн/міс + $0.40/млн |
| Retention повідомлень | 24 год (фіксовано) | 4 дні за замовчуванням, до 14 |
| Розмір повідомлення | 128 KB | 128 KB |
| Wall time consumer | 15 хв | 15 хв |
| CPU time | 10 ms | 30 с за замовчуванням, до 5 хв |
| Subrequests на виклик | 50 | 10 000 |
| Тіло вхідного запиту | 100 MB (залежить від тарифу домену) | те саме |

Один запис коштує близько 3–5 операцій Queues, тож Free вистачає з великим запасом. Код майже не використовує CPU (здебільшого чекає на мережу), тому 10 ms на Free має вистачати. Але якщо в логах з'являться `exceededCpu`, допоможе перехід на Paid.

Джерела: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Batching & retries](https://developers.cloudflare.com/queues/configuration/batching-retries/).

## Витрати Cloudflare

`npm run cost` (або `npm run cost -- 14`) друкує витрати по днях і продуктах за останні N днів (типово 7) з Billable Usage API (alpha). У `.env` потрібні `CLOUDFLARE_API_TOKEN` (токен із правом Billing Read: My Profile → API Tokens) і `CLOUDFLARE_ACCOUNT_ID`. API віддає поточний розрахунковий період, тож днів може бути менше за запит; дані оновлюються раз на день. Показується лише плата понад безкоштовні ліміти, фіксовані підписки (Workers Paid) не входять. Те саме без токена видно в дашборді Manage Account → Billing → Billable Usage.
