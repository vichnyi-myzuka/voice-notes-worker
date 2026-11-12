# Interface-модулі агента не залежать один від одного

**Рішення.** `interface/telegram`, `interface/github` і `interface/http` не імпортують один одного, окрім односпрямованого виклику обробників кнопок GitHub з `telegram/buttons.ts`. Спільне живе в `infrastructure/chat`: пости й клавіатури, формат `callback_data` (`callback.ts`, формує й розбирає тільки він) та дії над повідомленнями (`messages.ts`).

**Чому.** Раніше `github` імпортував `removeMessage`/`removeOriginal` з `telegram/handle`, а той — `review` з `github`: цикл. Формат кнопок був розкиданий по кількох файлах.

**Наслідки.** Обробники беруть лише потрібну частину порту: GitHub — `Sessions & Deploys`, HTTP — `Sessions & Computer`.
