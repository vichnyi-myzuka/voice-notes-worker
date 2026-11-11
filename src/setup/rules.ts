import { escapeRe } from "./plan";

export const SECTION = "[мітки]";

export const ruleRe = (name: string) => new RegExp(`^\\s*${escapeRe(name)}\\s*[—–-]\\s*`, "i");

export function labelSection(lines: string[]): [number, number] | null {
	const start = lines.findIndex((l) => l.trim().toLowerCase() === SECTION);
	if (start < 0) return null;
	const next = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
	return [start, next < 0 ? lines.length : next];
}

// Опис мітки з правил або "".
export function labelRule(rules: string, name: string): string {
	const lines = rules.split("\n");
	const sec = labelSection(lines);
	if (!sec) return "";
	const line = lines.slice(sec[0] + 1, sec[1]).find((l) => ruleRe(name).test(l));
	return line ? line.replace(ruleRe(name), "").trim() : "";
}

// Ставить («Мітка — опис») або прибирає (description = null) рядок мітки в секції [мітки].
export function setLabelRule(rules: string, name: string, description: string | null): string {
	const lines = rules.split("\n");
	const line = description ? `${name} — ${description}` : null;
	const sec = labelSection(lines);
	if (!sec) return line ? `${rules.trimEnd()}${rules.trim() ? "\n\n" : ""}${SECTION}\n${line}` : rules;
	const [start, end] = sec;
	const at = lines.findIndex((l, i) => i > start && i < end && ruleRe(name).test(l));
	if (at >= 0) {
		if (line) lines[at] = line;
		else lines.splice(at, 1);
	} else if (line) {
		let last = end - 1;
		while (last > start && !lines[last].trim()) last--; // після останнього непорожнього рядка секції
		lines.splice(last + 1, 0, line);
	}
	return lines.join("\n");
}
