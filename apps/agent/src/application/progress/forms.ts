import type { OpencodeClient, PendingForm, PostBoard, SessionStore } from "../../domain/agent";
import { WORKING } from "../jobs";

// Питання агента з кнопками-відповідями: стан форми живе у сховищі, відповідь передається агентові й показується в пості.
export class Forms {
	constructor(
		private readonly store: SessionStore,
		private readonly posts: PostBoard,
		private readonly opencode: OpencodeClient,
	) {}

	save(id: string, form: PendingForm): Promise<void> {
		return this.store.saveForm(id, form);
	}

	// Питання, що лишилось без відповіді (сесія завершилась чи видалена), неактуальне.
	drop(id: string): Promise<void> {
		return this.store.dropForm(id).then(() => undefined);
	}

	// Користувач написав текст замість кнопки: питання скасовується, текст іде агентові як відповідь.
	async cancel(id: string, message: string): Promise<void> {
		const form = await this.store.form(id);
		if (!form) return;
		await this.store.dropForm(id);
		await this.opencode.cancelForm(form.ocId, form.formId, message).catch((err) => console.error("form cancel failed:", err));
		const w = await this.store.watch(id);
		if (w) await this.posts.show(id, w, `${WORKING} · відповідь: ${message.slice(0, 100)}`).catch(() => {});
	}

	// Відповідь кнопкою: передає вибраний варіант агентові й показує його в пості. undefined — питання вже неактуальне.
	async answer(id: string, choice: number | "ok"): Promise<string | undefined> {
		const form = await this.store.form(id);
		if (!form) return undefined;
		const w = await this.store.watch(id);
		const sent = async (value: string | boolean | string[], label: string) => {
			const answers = { ...form.answers, [form.key]: value };
			const [step, ...rest] = form.next ?? [];
			if (step) {
				// Далі ще питання форми: показуємо наступне з його кнопками, агентові відповідь піде після останнього.
				await this.store.saveForm(id, { ...form, ...step, selected: [], next: rest, answers } satisfies PendingForm);
				if (w) await this.posts.show(id, w, step.text, false, { labels: step.choices.map((c) => c.label), multiple: step.multiple }).catch(() => {});
				return `Відповідь: ${label}`;
			}
			await this.opencode.replyForm(form.ocId, form.formId, answers);
			await this.store.dropForm(id);
			if (w) await this.posts.show(id, w, `${WORKING} · відповідь: ${label}`).catch(() => {});
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
		await this.store.saveForm(id, { ...form, selected } satisfies PendingForm);
		const labels = form.choices.map((c, i) => `${selected.includes(i) ? "☑" : "☐"} ${c.label}`);
		if (w) await this.posts.show(id, w, form.text, false, { labels, multiple: true }).catch(() => {});
		return selected.length ? `Вибрано: ${selected.sort((a, b) => a - b).map((i) => form.choices[i].label).join(", ")}` : "Нічого не вибрано";
	}
}
