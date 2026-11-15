# Скіли робочого процесу

Скіли `grilling`, `grill-me`, `tdd`, `diagnosing-bugs`, `codebase-design`, `code-review` взято з https://github.com/mattpocock/skills
(коміт 5863806, ліцензія MIT, див. `LICENSE-mattpocock-skills.md`, © 2026 Matt Pocock) і адаптовано під цього агента (OpenCode у чаті):

- `grilling`: питання раундами не текстом, а викликом `question`; факти шукає сам (`explore` через `subagent`); фінальне підтвердження теж через `question`. Перероблено повністю.
- `grill-me`: викликає `grilling` через інструмент `skill`; прибрано `disable-model-invocation`.
- `tdd`: узгодження тестових швів через `question`; `skill` замість «Skill tool».
- `diagnosing-bugs`: питання власнику через `question`; без браузера і без інтерактивного bash-скрипта (власник бачить лише чат), тож `scripts/hitl-loop.template.sh` не включено; гіпотези показуємо повідомленням, не блокуючи.
- `code-review`, `codebase-design`: підагенти через інструмент `subagent` (кілька викликів в одній відповіді = паралельно).

Оновлюючи з оригіналу, переніси ці правки (шукай за `question`, `subagent`, `skill` tool).
