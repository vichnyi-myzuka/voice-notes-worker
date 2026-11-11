import agents from "../../../payload/AGENTS.md";
import prePush from "../../../payload/pre-push.sh";
import publish from "../../../payload/publish.sh";
import sessionPrep from "../../../payload/session-prep.sh";

// Файли, які воркер розкладає в контейнер сам (а не кладе в образ): вони змінюються часто, і від цього не мають скидатися знімки
// та історія сесій. Нові сесії одразу працюють з актуальними версіями; старі сесії зберігають своє.
export type PayloadFile = { path: string; mode: string; content: string };

export const PAYLOAD: PayloadFile[] = [
	// Глобальні інструкції: OpenCode читає ~/.config/opencode/AGENTS.md, claude (провайдер Claude Agent) — ~/.claude/CLAUDE.md.
	{ path: "/root/.config/opencode/AGENTS.md", mode: "644", content: agents },
	{ path: "/root/.claude/CLAUDE.md", mode: "644", content: agents },
	{ path: "/usr/local/bin/publish", mode: "755", content: publish },
	{ path: "/usr/local/bin/session-prep", mode: "755", content: sessionPrep },
	// Запобіжник: пуш у main/master відхиляється (core.hooksPath задано в образі)
	{ path: "/usr/local/lib/git-hooks/pre-push", mode: "755", content: prePush },
];

// Відбиток вмісту: за ним видно, чи контейнер уже має актуальні файли.
export const PAYLOAD_HASH = (() => {
	let h = 0x811c9dc5;
	for (const c of JSON.stringify(PAYLOAD)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
	return (h >>> 0).toString(16);
})();

// Скрипт для `node -e` у контейнері: пише файли з PAYLOAD (JSON у змінній середовища) і ставить права. Node є в образі.
export const WRITER = `const fs=require("fs"),path=require("path");for(const f of JSON.parse(process.env.PAYLOAD)){fs.mkdirSync(path.dirname(f.path),{recursive:true});fs.writeFileSync(f.path,f.content);fs.chmodSync(f.path,parseInt(f.mode,8))}`;
