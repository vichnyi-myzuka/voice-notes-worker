---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use before implementing any non-trivial task, when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

The user is in a chat (Telegram or web), so you ask with the `question` tool, never as plain text in the reply. It shows buttons and waits for the answer.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in ONE `question` call: one entry in `questions` per decision, then wait for the answers before the next round.

Format each entry like so:

- `header`: a short label of the decision (up to 30 characters).
- `question`: the full question; context and trade-offs go here, multiple paragraphs are fine.
- `options`: the choices, your recommended answer FIRST with "(Recommended)" at the end of its label, and a one-line `description` of what each choice means. Set `multiple: true` only when several choices can be combined. The tool adds a free-text "Type your own answer" option itself: do not add one.

Word each question so that accepting the first option means "yes, your recommendation".

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (code, docs, git history, GitHub, the web), look it up yourself: read files directly, or for a wide search start an `explore` subagent with the `subagent` tool (it starts with a fresh context, so give it the full brief). Don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for it; ask the rest of the frontier now (start the subagent with `background: true`). The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Summarise the agreed decisions briefly and ask the user to confirm the shared understanding with the `question` tool ("Confirm" / "Change something"). Do not act on it until they confirm.
