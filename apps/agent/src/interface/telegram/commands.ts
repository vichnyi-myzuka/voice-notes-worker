import type { BotEnv } from "@voice-notes/core";
import type { Computer, SessionReport, Sessions } from "../../domain/agent";
import { removeMessage, removeOriginal } from "../../infrastructure/chat";
import { describeQuota, fetchQuota } from "../../infrastructure/quota";

export type Say = (text: string) => Promise<unknown>;

// Примусове оновлення: контейнер зупиняється, знімок видаляється; наступне завдання стартує з поточного образу (деплой
// і так робить це сам при першому зверненні, команда потрібна, коли оновити треба одразу). Працюючих агентів не чіпає без force.
export async function updateContainer(say: Say, agent: Computer, force: boolean): Promise<void> {
	if (!(await agent.resetComputer(!force))) {
		return void (await say("⏳ Зараз працює агент. Дочекайся завершення або надішли /update force, щоб перервати."));
	}
	await say("🔄 Контейнер зупинено: наступне завдання стартує з поточного образу. Старі сесії скинуто (гілки в GitHub лишились).");
}

// Ліміти підписки Claude (/quota): без токена підписки їх немає, збій запиту не валить обробник.
export async function quotaText(token?: string): Promise<string> {
	if (!token) return "ℹ️ Ліміти доступні лише за підписки Claude (потрібен CLAUDE_CODE_OAUTH_TOKEN).";
	try {
		return describeQuota(await fetchQuota(token));
	} catch (err) {
		console.error("quota failed:", err);
		return "⚠️ Не вдалося отримати ліміти Claude.";
	}
}

// /status, /stop, /delete у відповідь на пост сесії.
export async function sessionCommand(env: BotEnv, chat: number, agent: Sessions, say: Say, id: string, command: "/status" | "/stop" | "/delete", postId?: number): Promise<void> {
	if (!(await agent.link(id))) return void (await say("⚠️ Сесію не знайдено."));
	if (command === "/delete") {
		await agent.remove(id);
		if (postId) await removeMessage(env, chat, postId);
		await removeOriginal(env, chat, id);
		return; // підтвердження не шлемо: пост і сама команда зникають з чату
	}
	const report = await agent.report(id);
	if (command === "/stop") {
		if (report.status !== "working") return void (await say(`Нічого зупиняти: ${describe(report)}`));
		await agent.abort(id);
		return void (await say("⏹ Зупинено. Відповідь на пост із сесією продовжить роботу."));
	}
	await say(describe(report));
}

// Стан сесії для людини: працює / чекає / завершила / помилка / зупинена / контейнер спить.
export function describe({ status, outcome, cost, tokens }: SessionReport): string {
	const state =
		status === "stopped" ? "💤 Контейнер спить, історія збережена. Уточнення розбудить його."
		: status === "working" ? "⏳ Працює"
		: outcome === "succeeded" ? "✅ Завершила"
		: outcome === "failed" ? "❌ Завершилась помилкою"
		: outcome === "interrupted" ? "⏹ Зупинена"
		: "💤 Чекає на відповідь";
	const spent = [cost ? `$${cost.toFixed(2)}` : "", tokens ? `${Math.round(tokens / 1000)}k токенів` : ""].filter(Boolean).join(" · ");
	return spent ? `${state} (${spent})` : state;
}
