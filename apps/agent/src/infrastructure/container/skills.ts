import type { PayloadFile } from "./payload";
import s0 from "../../../payload/skills/code-review/SKILL.md";
import s1 from "../../../payload/skills/codebase-design/DEEPENING.md";
import s2 from "../../../payload/skills/codebase-design/DESIGN-IT-TWICE.md";
import s3 from "../../../payload/skills/codebase-design/SKILL.md";
import s4 from "../../../payload/skills/diagnosing-bugs/SKILL.md";
import s6 from "../../../payload/skills/grill-me/SKILL.md";
import s7 from "../../../payload/skills/grilling/SKILL.md";
import s8 from "../../../payload/skills/tdd/SKILL.md";
import s9 from "../../../payload/skills/tdd/mocking.md";
import s10 from "../../../payload/skills/tdd/tests.md";

// Скіли робочого процесу з https://github.com/mattpocock/skills (MIT, з адаптацією під OpenCode; див. payload/skills/README.md). Агент підхоплює їх сам
// за description; як їх застосовувати в цьому середовищі, сказано в розділі «Approach» файлу payload/AGENTS.md. OpenCode читає
// ~/.config/opencode/skills, claude — ~/.claude/skills. Новий файл скіла треба додати в цей список.
const FILES: [string, string][] = [
	["code-review/SKILL.md", s0],
	["codebase-design/DEEPENING.md", s1],
	["codebase-design/DESIGN-IT-TWICE.md", s2],
	["codebase-design/SKILL.md", s3],
	["diagnosing-bugs/SKILL.md", s4],
	["grill-me/SKILL.md", s6],
	["grilling/SKILL.md", s7],
	["tdd/SKILL.md", s8],
	["tdd/mocking.md", s9],
	["tdd/tests.md", s10],
];

const ROOTS = ["/root/.config/opencode/skills", "/root/.claude/skills"];

export const WORKFLOW_SKILL_FILES: PayloadFile[] = ROOTS.flatMap((root) =>
	FILES.map(([path, content]) => ({ path: `${root}/${path}`, mode: "644", content })),
);
