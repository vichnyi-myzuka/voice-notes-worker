import type { Posts } from "./posts";
import { WORKING } from "./config";
import { formKey, watchKey, type PendingForm, type Watch } from "./state";
import { replyForm, type Opencode } from "./opencode";

// Питання агента з кнопками-відповідями: стан форми живе у сховищі, відповідь передається агентові й показується в пості.
export class Forms {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly posts: Posts,
		private readonly opencode: () => Opencode,
	) {}

	save(id: string, form: PendingForm): Promise<void> {
		return this.storage.put(formKey(id), form);
	}

	// Питання, що лишилось без відповіді (сесія завершилась чи видалена), неактуальне.
	drop(id: string): Promise<void> {
		return this.storage.delete(formKey(id)).then(() => undefined);
	}

	// Відповідь кнопкою: передає вибраний варіант агентові й показує його в пості. undefined — питання вже неактуальне.
	async answer(id: string, choice: number | "ok"): Promise<string | undefined> {
		const form = await this.storage.get<PendingForm>(formKey(id));
		if (!form) return undefined;
		const w = await this.storage.get<Watch>(watchKey(id));
		const sent = async (value: string | boolean | string[], label: string) => {
			await replyForm(this.opencode(), form.ocId, form.formId, { [form.key]: value });
			await this.storage.delete(formKey(id));
			if (w) await this.posts.show(w, `${WORKING} · відповідь: ${label}`).catch(() => {});
			return `Відповідь: ${label}`;
		};
		if (!form.multiple) {
			const picked = choice === "ok" ? undefined : form.choices[choice];
			return picked && (await sent(picked.value, picked.label));
		}
		// Множинний вибір: кнопки перемикають варіанти (позначка в підписі), «Підтвердити» надсилає вибране.
		if (choice === "ok") {
			if (form.selected.length === 0) return "Вибери хоча б один варіант.";
			const picked = form.selected.sort((a, b) => a - b).map((i) => form.choices[i]);
			return sent(picked.map((c) => c.value as string), picked.map((c) => c.label).join(", "));
		}
		if (!form.choices[choice]) return undefined;
		const selected = form.selected.includes(choice) ? form.selected.filter((i) => i !== choice) : [...form.selected, choice];
		await this.storage.put(formKey(id), { ...form, selected } satisfies PendingForm);
		const labels = form.choices.map((c, i) => `${selected.includes(i) ? "☑" : "☐"} ${c.label}`);
		if (w) await this.posts.show(w, form.text, false, { labels, multiple: true }).catch(() => {});
		return selected.length ? `Вибрано: ${selected.sort((a, b) => a - b).map((i) => form.choices[i].label).join(", ")}` : "Нічого не вибрано";
	}
}
