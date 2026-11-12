// Підпис поточної дії агента для поста в чаті: з назви інструмента (session.tool.input.started) і аргументів (session.tool.called).
// Команди bash не показуємо повністю (у них можуть бути токени): лише назву програми.

const MAX = 60;
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

// Шлях без префікса теки сесії: `/workspace/sessions/<тека>/src/a.ts` → `src/a.ts`.
const short = (p: string) => p.replace(/^\/workspace\/(?:sessions\/[^/]+\/|repos\/[^/]+\/[^/]+\/)?/, "");

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// Питання агента (інструмент question створює форму, подія form.created): заголовок, поля й варіанти відповіді для поста.
const FORM_MAX = 1200; // пост разом із шапкою має вміститись у 4096
export type ActivityForm = { title?: string; fields?: { key?: string; type?: string; hidden?: boolean; title?: string; description?: string; maxItems?: number; options?: { value?: string; label?: string; description?: string }[] }[] };

// Кнопки-відповіді: лише для питань з одним видимим полем (варіанти, так/ні або множинний вибір); складні форми відповідаються текстом.
export type Choice = { label: string; value: string | boolean | string[] };
const MAX_CHOICES = 8;
export function formChoices(form: ActivityForm): { key: string; choices: Choice[]; multiple?: boolean } | undefined {
	const fields = (form.fields ?? []).filter((f) => !f.hidden);
	const field = fields.length === 1 ? fields[0] : undefined;
	if (!field?.key) return undefined;
	const options = (field.options ?? []).filter((o) => o.label && o.value !== undefined).slice(0, MAX_CHOICES);
	if (field.type === "boolean") return { key: field.key, choices: [{ label: "Так", value: true }, { label: "Ні", value: false }] };
	if (field.type === "string" && options.length > 0) return { key: field.key, choices: options.map((o) => ({ label: o.label!, value: o.value! })) };
	if (field.type === "multiselect" && field.maxItems === 1 && options.length > 0) return { key: field.key, choices: options.map((o) => ({ label: o.label!, value: [o.value!] })) };
	// Множинний вибір: кнопки перемикають варіанти, «Підтвердити» надсилає масив вибраних значень.
	if (field.type === "multiselect" && options.length > 0) return { key: field.key, multiple: true, choices: options.map((o) => ({ label: o.label!, value: o.value! })) };
	return undefined;
}

export function describeForm(form: ActivityForm): string {
	const parts = [form.title?.trim() || "Агент питає", ...(form.fields ?? []).flatMap((f) => [f.title?.trim() && f.title.trim() !== form.title?.trim() ? f.title.trim() : "", f.description?.trim() ?? "", ...(f.options ?? []).map((o) => `• ${o.label ?? ""}${o.description ? `: ${o.description}` : ""}`)])].filter(Boolean);
	const text = `❓ ${parts.join("\n")}\n\nВідповідай на цей пост.`;
	return text.length > FORM_MAX ? `${text.slice(0, FORM_MAX)}…` : text;
}

// Аргументи інструмента, що не має відомих полів (MCP): короткі скалярні значення «ключ значення», без id, пагінації й довгих рядків.
// Так видно, що саме шукають («start date 2025-10-01, category Їжа»), а не лише назву інструмента.
export function argSummary(input: Record<string, unknown> | undefined, max = 3): string {
	const skip = /(^|_)(id|ids|page|per_page|limit|offset)$/;
	return Object.entries(input ?? {})
		.filter(([k, v]) => !skip.test(k) && (typeof v === "string" ? v.trim() && v.length <= 40 : typeof v === "number" || typeof v === "boolean"))
		.slice(0, max)
		.map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v).trim()}`)
		.join(", ");
}

// Інструменти MCP Sure (`sure_get_transactions`): що робить виклик словами. Невідомий інструмент отримує назву без префікса й аргументи.
const SURE_VERBS: Record<string, string> = {
	get_transactions: "дивиться транзакції",
	get_transaction: "відкриває транзакцію",
	get_accounts: "дивиться рахунки",
	get_account: "відкриває рахунок",
	get_balance_sheet: "дивиться баланс і чисті активи",
	get_categories: "дивиться категорії",
	get_budgets: "дивиться бюджети",
	get_tags: "дивиться мітки",
	get_merchants: "дивиться отримувачів",
	update_transaction: "оновлює транзакцію",
	create_transaction: "створює транзакцію",
	delete_transaction: "видаляє транзакцію",
};

function describeSure(name: string, input: Record<string, unknown> | undefined): string {
	const verb = SURE_VERBS[name] ?? `викликає Sure: ${name.replace(/_/g, " ")}`;
	const args = argSummary(input);
	return cut(args ? `${verb} (${args})` : verb);
}

export function describeActivity(tool: string, input: Record<string, unknown> | undefined): string {
	const i = input ?? {};
	const file = str(i.filePath) ?? str(i.path) ?? str(i.file);
	switch (tool) {
		case "read":
			return file ? `читає ${cut(short(file))}` : "читає файл";
		case "edit":
		case "write":
		case "patch":
		case "multiedit":
			return file ? `редагує ${cut(short(file))}` : "редагує файл";
		case "bash":
		case "shell": {
			const program = str(i.command)?.split("\n")[0].split(/\s+/)[0];
			return program ? `виконує ${cut(program)}` : "виконує команду";
		}
		case "grep":
		case "glob":
		case "list":
			return str(i.pattern) ? `шукає ${cut(str(i.pattern)!)}` : "шукає у файлах";
		case "webfetch":
		case "websearch": {
			const target = str(i.url) ?? str(i.query);
			return target ? `відкриває ${cut(target.replace(/^https?:\/\//, ""))}` : "шукає в інтернеті";
		}
		case "question":
			return "ставить питання";
		case "task":
			return "делегує підзадачу";
		default: {
			if (tool.startsWith("sure_")) return describeSure(tool.slice("sure_".length), i);
			const args = argSummary(i);
			return cut(args ? `інструмент ${tool} (${args})` : `інструмент ${tool}`);
		}
	}
}
