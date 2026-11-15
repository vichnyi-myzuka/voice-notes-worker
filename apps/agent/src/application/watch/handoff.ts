import type { Handoff } from "../../domain/agent";

// Агент передає роботу в нову сесію командою `handoff [--repo …] [--name …] <<'EOF' … EOF` (payload/handoff.sh): воркер бачить
// її у виклику bash у потоці подій OpenCode (як request-mcp і set-repo) і разом із командою отримує текст heredoc.
const HANDOFF = /(?:^|[\s;&|(])handoff((?:[ \t]+--(?:repo|name)(?:=|[ \t]+)\S+)*)[ \t]*<<-?[ \t]*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?:\n|$|[;&|)])/;
const FLAG = /--(repo|name)(?:=|[ \t]+)(\S+)/g;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Передана задача з виклику інструмента bash (input.command) чи undefined, якщо це інша команда чи текст порожній.
export function handedOff(input: Record<string, unknown> | undefined): Handoff | undefined {
	const command = typeof input?.command === "string" ? input.command : "";
	const match = HANDOFF.exec(command);
	const task = match?.[4].trim();
	if (!match || !task) return undefined;
	const out: Handoff = { task };
	for (const [, flag, value] of match[1].matchAll(FLAG)) {
		const v = value.replace(/^["']|["']$/g, "");
		if (flag === "repo") out.repo = v === "none" ? null : REPO.test(v) ? v : out.repo;
		else if (NAME.test(v)) out.name = v;
	}
	return out;
}

// Id нової сесії від id батьківської й виклику інструмента: повтор тієї самої події не створює другу сесію.
export function handoffId(parentId: string, callId: string): string {
	let h = 0x811c9dc5;
	for (const c of callId) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
	return `${parentId}-h${(h >>> 0).toString(36)}`;
}
