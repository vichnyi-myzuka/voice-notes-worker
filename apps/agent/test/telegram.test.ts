import { afterEach, describe, expect, it, vi } from "vitest";
import type { Llm } from "@voice-notes/core";
import type { Env } from "../src/env";
import { handleTelegram, parseRepos } from "../src/interface/telegram";
import { describe as describeReport, EPHEMERAL_MS } from "../src/interface/telegram/handle";
import { fakeAgent } from "./fake-agent";

// timingSafeEqual є лише в workerd: у Node мокаємо порівняння (мок за шляхом файлу в core).
vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

const env = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42", CHAT_ID: "-1001" } as unknown as Env;
const OWNER = 42;
const TEMP_ID = 500; // message_id, який мок Telegram віддає службовим відповідям з 💨
const CHANNEL = -1001;

// Telegram Bot API на підміненому fetch: запам'ятовує виклики методів і віддає файл для getFile.
function setup(transcript = "Поправ README", pick?: (user: string) => { repo?: string; type?: string; name?: string } | null) {
	const agent = fakeAgent();
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
			const method = input.split("/").pop()!;
			calls.push({ method, body: JSON.parse(init!.body as string) });
			return Response.json({ ok: true, result: method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: method === "sendMessage" && String(JSON.parse(init!.body as string).text).endsWith(" 💨") ? TEMP_ID : 1 } });
		}),
	);
	const llm: Llm = {
		askJson: (async (req: { user: string }, parse: (t: string) => unknown) => {
			const answer = pick?.(req.user);
			return answer ? parse(JSON.stringify(answer)) : null;
		}) as Llm["askJson"],
		transcribe: vi.fn(async () => transcript) };
	const pending: Promise<unknown>[] = [];
	const sleep = vi.fn(async (_ms: number) => {});
	const deps = { agent: agent.agent, llm, repos: parseRepos(JSON.stringify([{ repo: "me/bot", about: "our bot" }, { repo: "me/site", about: "the website" }])), defer: (w: Promise<unknown>) => void pending.push(w), sleep };
	const send = async (message: unknown, headers: HeadersInit = { "x-telegram-bot-api-secret-token": "secret" }) => {
		const channel = (message as { chat: { type: string } }).chat.type === "channel";
		const res = await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers, body: JSON.stringify({ update_id: 1, ...(channel ? { channel_post: message } : { message }) }) }), env, deps);
		await Promise.all(pending.splice(0)); // фонова робота до кінця
		return res;
	};
	const press = async (data: string, from = OWNER, chat: { id: number; type: string } = { id: OWNER, type: "private" }) => {
		const query = { id: "cb1", from: { id: from }, message: { message_id: 100, chat }, data };
		const res = await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ update_id: 2, callback_query: query }) }), env, deps);
		await Promise.all(pending.splice(0));
		return res;
	};
	const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
	const replies = () => calls.filter((c) => c.method === "sendMessage").map((c) => (c.body.text as string).replace(/ 💨$/, ""));
	return { ...agent, llm, sleep, send, press, answers, calls, replies };
}

const post = (extra: Record<string, unknown>, id = 9) => ({ message_id: id, date: 1, chat: { id: CHANNEL, type: "channel" }, ...extra });
const msg = (extra: Record<string, unknown>, id = 7) => ({ message_id: id, date: 1, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, ...extra });

afterEach(() => vi.unstubAllGlobals());

describe("вебхук Telegram", () => {
	it("без секрета чи з чужим — 401, нічого не створює", async () => {
		const { send, sessions, calls } = setup();
		expect((await send(msg({ text: "задача" }), {})).status).toBe(401);
		expect((await send(msg({ text: "задача" }), { "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
		expect(sessions.size).toBe(0);
		expect(calls).toEqual([]);
	});

	it("текст → сесія з цим промптом і відповідь із посиланням, ✍ на повідомленні", async () => {
		const { send, sessions, replies, calls } = setup();
		expect((await send(msg({ text: "Поправ README" }))).status).toBe(200);
		expect([...sessions.values()].map((s) => s.input)).toEqual([{ prompt: "Поправ README" }]);
		expect(replies()).toEqual([`⏳ Запускаю\n\n🔗 <a href="https://agent.example/s/tg-${OWNER}-7">Відкрити сесію</a>`]);
		expect(calls.find((c) => c.method === "setMessageReaction")?.body).toMatchObject({ message_id: 7 });
	});

	it("голосове → транскрипція Whisper стає промптом, у відповіді видно, що розібрано", async () => {
		const { send, sessions, replies, llm } = setup("Додай CHANGELOG");
		await send(msg({ voice: { file_id: "f1", file_size: 1000, mime_type: "audio/ogg" } }));
		expect(llm.transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), "audio/ogg");
		expect([...sessions.values()][0].input.prompt).toBe("Додай CHANGELOG");
		expect(replies()).toEqual([`<blockquote expandable>🗣 Додай CHANGELOG</blockquote>\n\n⏳ Запускаю\n\n🔗 <a href="https://agent.example/s/tg-${OWNER}-7">Відкрити сесію</a>`]);
	});

	it("повторна доставка того самого повідомлення не створює другу сесію", async () => {
		const { send, sessions, replies } = setup();
		await send(msg({ text: "Поправ README" }));
		await send(msg({ text: "Поправ README" }));
		expect(sessions.size).toBe(1);
		expect(replies()).toHaveLength(1); // друга відповідь не публікується
	});

	it("інше повідомлення — інша сесія", async () => {
		const { send, sessions } = setup();
		await send(msg({ text: "перша" }, 7));
		await send(msg({ text: "друга" }, 8));
		expect(sessions.size).toBe(2);
	});

	it("канал: пост із задачею замінюється постом із текстом і посиланням, оригінал видаляється", async () => {
		const { send, sessions, calls } = setup();
		expect((await send(post({ text: "Поправ README" }))).status).toBe(200);
		expect([...sessions.values()].map((s) => s.input)).toEqual([{ prompt: "Поправ README" }]);
		const sent = calls.find((c) => c.method === "sendMessage")!.body;
		expect(sent).toMatchObject({ chat_id: CHANNEL, text: `Поправ README\n\n⏳ Запускаю\n\n🔗 <a href="https://agent.example/s/tg-${CHANNEL}-9">Відкрити сесію</a>`, parse_mode: "HTML" });
		expect(calls.find((c) => c.method === "deleteMessage")?.body).toEqual({ chat_id: CHANNEL, message_id: 9 });
		// порядок: спершу нова відповідь, потім видалення оригіналу
		expect(calls.map((c) => c.method).filter((m) => ["sendMessage", "deleteMessage"].includes(m))).toEqual(["sendMessage", "deleteMessage"]);
	});

	it("канал: голосове розпізнається, у пості видно розшифровку; повтор не дублює пост", async () => {
		const { send, sessions, calls } = setup("Додай CHANGELOG");
		await send(post({ voice: { file_id: "f1", file_size: 10 } }));
		await send(post({ voice: { file_id: "f1", file_size: 10 } }));
		expect(sessions.size).toBe(1);
		const posts = calls.filter((c) => c.method === "sendMessage");
		expect(posts).toHaveLength(1);
		expect(posts[0].body.text).toContain("<blockquote expandable>🗣 Додай CHANGELOG</blockquote>");
	});

	it("у приваті оригінал лишається: нічого не видаляється", async () => {
		const { send, calls } = setup();
		await send(msg({ text: "Поправ README" }));
		expect(calls.some((c) => c.method === "deleteMessage")).toBe(false);
	});

	it("у приваті голосове видаляється: транскрипт уже в пості сесії", async () => {
		const { send, calls } = setup();
		await send(post({ voice: { file_id: "f1", file_size: 10 } }));
		expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
	});

	it("чужий користувач, чужий канал і група ігноруються", async () => {
		const { send, sessions, calls } = setup();
		await send({ ...msg({ text: "задача" }), from: { id: 7 }, chat: { id: 7, type: "private" } });
		await send({ ...msg({ text: "задача" }), chat: { id: -2002, type: "channel" } });
		await send({ ...msg({ text: "задача" }), chat: { id: -5, type: "group" } });
		expect(sessions.size).toBe(0);
		expect(calls).toEqual([]);
	});

	it("порожня транскрипція й завеликий файл — підказка, сесії немає", async () => {
		const empty = setup("");
		await empty.send(msg({ voice: { file_id: "f1", file_size: 10 } }));
		expect(empty.sessions.size).toBe(0);
		expect(empty.replies()[0]).toContain("Не розібрав");

		const big = setup();
		await big.send(msg({ voice: { file_id: "f1", file_size: 25_000_000 } }));
		expect(big.sessions.size).toBe(0);
		expect(big.llm.transcribe).not.toHaveBeenCalled();
		expect(big.replies()[0]).toContain("20 МБ");
	});

	it("/start і команди сесії не створюють", async () => {
		const { send, sessions, replies } = setup();
		await send(msg({ text: "/start" }));
		await send(msg({ text: "/help" }, 8));
		expect(sessions.size).toBe(0);
		expect(replies()).toHaveLength(1);
	});

	describe("керування сесією з чату", () => {
		const SID = `tg-${OWNER}-7`;
		const botPost = (text = `задача\n\n🔗 https://agent.example/s/${SID}`) => ({ message_id: 100, text });
		// Сесія вже створена першим повідомленням, далі користувач відповідає на пост бота.
		const withSession = async (transcript?: string) => {
			const t = setup(transcript);
			await t.send(msg({ text: "Поправ README" }));
			t.calls.length = 0;
			return t;
		};

		it("нова сесія береться під спостереження: після завершення підсумок прийде в той самий чат", async () => {
			const { send, watches } = setup();
			await send(msg({ text: "Поправ README" }));
			expect(watches).toEqual([{ id: SID, target: { chatId: OWNER, url: `https://agent.example/s/${SID}`, postId: 1, header: "" } }]); // postId — пост бота (його id віддає sendMessage), header — його шапка
		});

		it("відповідь текстом на пост із сесією — уточнення в ту саму сесію, нової сесії немає", async () => {
			const { send, sessions, watches, replies } = await withSession();
			await send(msg({ text: "Ще й CHANGELOG", reply_to_message: botPost() }, 8));
			expect(sessions.size).toBe(1);
			expect(sessions.get(SID)?.messages).toEqual(["Поправ README", "Ще й CHANGELOG"]);
			expect(watches).toHaveLength(2); // стежимо за новою роботою
			expect(watches[1].target).toEqual({ chatId: OWNER, url: `https://agent.example/s/${SID}` }); // пост сесії агент знає сам (зі сховища)
			expect(replies()).toEqual([]);
		});

		it("уточнення після прийняття видаляється з чату (як правка нотатки)", async () => {
			const { send, calls } = await withSession();
			await send(msg({ text: "Ще й CHANGELOG", reply_to_message: botPost() }, 8));
			expect(calls.filter((c) => c.method === "deleteMessage").map((c) => c.body)).toEqual([{ chat_id: OWNER, message_id: 8 }]);
		});

		it("відповідь голосом: розпізнається й іде в ту саму сесію", async () => {
			const { send, sessions } = await withSession("Додай тести");
			await send(msg({ voice: { file_id: "f1", file_size: 10 }, reply_to_message: botPost() }, 8));
			expect(sessions.get(SID)?.messages.at(-1)).toBe("Додай тести");
		});

		it("посилання сховане під «Відкрити сесію» (text_link): відповідь однаково знаходить сесію", async () => {
			const { send, sessions } = await withSession();
			const hidden = { message_id: 100, text: "задача\n\n🔗 Відкрити сесію", entities: [{ type: "text_link", offset: 10, length: 14, url: `https://agent.example/s/${SID}` }] };
			await send(msg({ text: "Ще й CHANGELOG", reply_to_message: hidden }, 8));
			expect(sessions.size).toBe(1);
			expect(sessions.get(SID)?.messages).toEqual(["Поправ README", "Ще й CHANGELOG"]);
		});

		it("відповідь на повідомлення без посилання на сесію — звичайна нова задача", async () => {
			const { send, sessions } = await withSession();
			await send(msg({ text: "Нова задача", reply_to_message: botPost("просто текст") }, 8));
			expect(sessions.size).toBe(2);
		});

		it("відповідь на пост чужої сесії — підказка, а не помилка чи нова сесія", async () => {
			const { send, sessions, replies } = await withSession();
			await send(msg({ text: "Продовж", reply_to_message: botPost("🔗 https://agent.example/s/tg-1-1") }, 8));
			expect(sessions.size).toBe(1);
			expect(replies()[0]).toContain("Сесію не знайдено");
		});

		it("/status показує стан, /stop зупиняє роботу, повторний /stop нічого не робить", async () => {
			const { send, sessions, replies } = await withSession();
			await send(msg({ text: "/status", reply_to_message: botPost() }, 8));
			await send(msg({ text: "/stop", reply_to_message: botPost() }, 9));
			expect(sessions.get(SID)?.status).toBe("idle");
			await send(msg({ text: "/stop", reply_to_message: botPost() }, 10));
			await send(msg({ text: "/status", reply_to_message: botPost() }, 11));
			expect(replies()).toEqual(["⏳ Працює", "⏹ Зупинено. Відповідь на пост із сесією продовжить роботу.", "Нічого зупиняти: ⏹ Зупинена", "⏹ Зупинена"]);
		});

		it("/delete видаляє сесію й пост; наступні команди бачать, що її немає", async () => {
			const { send, sessions, replies } = await withSession();
			await send(msg({ text: "/delete", reply_to_message: botPost() }, 8));
			expect(sessions.has(SID)).toBe(false);
			await send(msg({ text: "/status", reply_to_message: botPost() }, 9));
			expect(replies()).toEqual(["⚠️ Сесію не знайдено."]); // про саме видалення бот мовчить
		});

		describe("репозиторій і назва з вільної мови", () => {
			it("модель вибрала репозиторій і назву: сесія з repo та name, у пості видно 📦; промпт без змін", async () => {
				const { send, sessions, replies } = setup("", (user) => (user.includes("our bot") ? { repo: "me/bot", evidence: "нашим ботом", type: "test", name: "session-tests" } : null));
				await send(msg({ text: "Давай попрацюємо над нашим ботом, додай тести" }));
				expect([...sessions.values()].map((s) => s.input)).toEqual([{ prompt: "Давай попрацюємо над нашим ботом, додай тести", repo: "me/bot", name: "test-session-tests" }]);
				expect(replies()[0]).toMatch(/📦 me\/bot\n🌿 agent\/test-session-tests-\d+\n/);
			});

			it("репозиторій без цитати з фрази (вигаданий моделлю) відкидається, назва лишається", async () => {
				for (const evidence of ["", "ботом тут не пахне", "ab"]) {
					const { send, sessions } = setup("", () => ({ repo: "me/bot", evidence, type: "feat", name: "business-card" }));
					await send(msg({ text: "Зроби сайт-візитку з привітанням і опублікуй її як HelloTest" }));
					expect([...sessions.values()].map((s) => s.input)).toEqual([{ prompt: "Зроби сайт-візитку з привітанням і опублікуй її як HelloTest", name: "feat-business-card" }]);
				}
			});

			it("«none», репозиторій поза списком чи збій моделі: без репозиторію; назва лишається, якщо придатна", async () => {
				for (const [pick, input] of [
					[() => ({ repo: "none", type: "feat", name: "new-thing" }), { prompt: "Зроби щось нове", name: "feat-new-thing" }],
					[() => ({ repo: "evil/repo", type: "bogus", name: "Fix README!" }), { prompt: "Зроби щось нове", name: "fix-readme" }],
					[() => ({ repo: "none", name: "?" }), { prompt: "Зроби щось нове" }],
					[() => null, { prompt: "Зроби щось нове" }],
				] as const) {
					const { send, sessions } = setup("", pick);
					await send(msg({ text: "Зроби щось нове" }));
					expect([...sessions.values()].map((s) => s.input)).toEqual([input]);
				}
			});

			it("явний префікс сильніший і репозиторій не вгадується, але назва придумується", async () => {
				const pick = vi.fn((_: string) => ({ repo: "me/site", type: "docs", name: "readme" }));
				const { send, sessions } = setup("", pick);
				await send(msg({ text: "other/repo: Поправ README" }));
				expect([...sessions.values()].map((s) => s.input)).toEqual([{ prompt: "Поправ README", repo: "other/repo", name: "docs-readme" }]);
				expect(pick.mock.calls[0][0]).not.toContain("me/site"); // список репозиторіїв моделі не показано
			});

			it("parseRepos ігнорує сміття й некоректні елементи", () => {
				expect(parseRepos(undefined)).toEqual([]);
				expect(parseRepos("not json")).toEqual([]);
				expect(parseRepos('{"repo":"a/b"}')).toEqual([]);
				expect(parseRepos('[{"repo":"a/b","about":"x"},{"repo":"bad","about":"x"},{"repo":"c/d"},null]')).toEqual([{ repo: "a/b", about: "x" }]);
			});
		});

		it("команди /status, /stop, /delete видаляються з чату після виконання; відповідь бота лишається", async () => {
			const { send, calls } = await withSession();
			await send(msg({ text: "/status", reply_to_message: botPost() }, 8));
			await send(msg({ text: "/stop", reply_to_message: botPost() }, 9));
			const deleted = () => calls.filter((c) => c.method === "deleteMessage" && c.body.message_id !== TEMP_ID).map((c) => c.body.message_id);
			expect(deleted()).toEqual([8, 9]);
			await send(msg({ text: "/delete", reply_to_message: botPost() }, 10));
			expect(deleted()).toEqual([8, 9, 100, 7, 10]); // пост сесії, оригінал у приваті (7) і сама команда
		});

		it("/update: без працюючих агентів скидає контейнер; зайнятий — просить force; /update force перериває", async () => {
			const { send, sessions, replies, resets, calls } = await withSession(); // сесія працює
			await send(msg({ text: "/update" }, 8));
			expect(resets).toHaveLength(0);
			expect(replies().at(-1)).toContain("/update force");
			sessions.get(SID)!.status = "idle";
			await send(msg({ text: "/update" }, 9));
			expect(resets).toHaveLength(1);
			expect(replies().at(-1)).toContain("Контейнер зупинено");
			sessions.get(SID)!.status = "working";
			await send(msg({ text: "/update force" }, 10));
			expect(resets).toHaveLength(2);
			expect(calls.filter((c) => c.method === "deleteMessage" && c.body.message_id !== TEMP_ID).map((c) => c.body.message_id)).toEqual([8, 9, 10]); // команди прибрано
		});

		it("/quota без токена підписки пояснює, чому ліміти недоступні, і прибирає команду", async () => {
			const { send, replies, calls } = setup();
			await send(msg({ text: "/quota" }, 12));
			expect(replies()).toEqual(["ℹ️ Ліміти доступні лише за підписки Claude (потрібен CLAUDE_CODE_OAUTH_TOKEN)."]);
			expect(calls.filter((c) => c.method === "deleteMessage" && c.body.message_id !== TEMP_ID).map((c) => c.body.message_id)).toEqual([12]);
		});

		it("відповідь команди має 💨 і видаляється через EPHEMERAL_MS; /start лишається", async () => {
			const { send, calls, sleep } = setup();
			await send(msg({ text: "/quota" }, 12));
			const sent = calls.find((c) => c.method === "sendMessage")!.body.text as string;
			expect(sent.endsWith(" 💨")).toBe(true);
			expect(sleep.mock.calls).toEqual([[EPHEMERAL_MS]]);
			expect(calls.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id).sort()).toEqual([12, TEMP_ID]); // і команда, і відповідь
			calls.length = 0;
			await send(msg({ text: "/start" }, 13));
			expect(calls.filter((c) => c.method === "deleteMessage" && c.body.message_id === TEMP_ID)).toEqual([]);
		});

		it("команда без відповіді на пост просить відповісти на пост із сесією", async () => {
			const { send, replies } = setup();
			await send(msg({ text: "/status" }));
			expect(replies()).toEqual(["Надішли /status відповіддю на пост із сесією."]);
		});

		it("«owner/name: задача» задає репозиторій, решта тексту — задача", async () => {
			const { send, sessions, replies } = setup();
			await send(msg({ text: "vichnyi-myzuka/voice-notes-worker: Поправ README" }));
			expect([...sessions.values()][0].input).toEqual({ prompt: "Поправ README", repo: "vichnyi-myzuka/voice-notes-worker" });
			expect(replies()[0]).toContain("📦 vichnyi-myzuka/voice-notes-worker");
			await send(msg({ text: "Подивись https://example.com: що там" }, 8)); // посилання — не репозиторій
			expect([...sessions.values()][1].input).toEqual({ prompt: "Подивись https://example.com: що там" });
		});

		it("describe: працює / чекає / завершила / помилка / зупинена / сплячий контейнер, з вартістю", () => {
			expect(describeReport({ status: "working" })).toBe("⏳ Працює");
			expect(describeReport({ status: "idle" })).toBe("💤 Чекає на відповідь");
			expect(describeReport({ status: "idle", outcome: "succeeded", cost: 0.4, tokens: 12_400 })).toBe("✅ Завершила ($0.40 · 12k токенів)");
			expect(describeReport({ status: "idle", outcome: "failed" })).toBe("❌ Завершилась помилкою");
			expect(describeReport({ status: "stopped" })).toContain("Контейнер спить");
		});
	});

	describe("кнопки під постом сесії", () => {
		const SESSION = `tg-${OWNER}-7`;
		const started = async () => {
			const t = setup();
			await t.send(msg({ text: "Поправ README" }));
			t.calls.length = 0;
			return t;
		};

		it("пост сесії створюється з кнопками «Стоп» і «Видалити»", async () => {
			const t = setup();
			await t.send(msg({ text: "Поправ README" }));
			const sent = t.calls.find((c) => c.method === "sendMessage")!.body as { reply_markup: unknown };
			expect(sent.reply_markup).toEqual({ inline_keyboard: [[{ text: "⏹ Стоп", callback_data: `stop:${SESSION}` }, { text: "🗑 Видалити", callback_data: `del:${SESSION}` }]] });
		});

		it("«Стоп» зупиняє працюючу сесію, відповідає підказкою й нічого не пише в чат", async () => {
			const t = await started();
			await t.press(`stop:${SESSION}`);
			expect(t.sessions.get(SESSION)?.status).toBe("idle");
			expect(t.answers()).toEqual(["⏹ Зупинено."]);
			expect(t.replies()).toEqual([]);
			await t.press(`stop:${SESSION}`); // вже не працює
			expect(t.answers().at(-1)).toBe("Нічого зупиняти.");
		});

		it("«Видалити» прибирає сесію й сам пост (з каналу теж)", async () => {
			const t = await started();
			await t.press(`del:${SESSION}`, OWNER, { id: CHANNEL, type: "channel" });
			expect(t.sessions.has(SESSION)).toBe(false);
			expect(t.calls.filter((c) => c.method === "deleteMessage").map((c) => c.body)).toEqual([{ chat_id: CHANNEL, message_id: 100 }]);
			expect(t.answers()).toEqual(["Сесію видалено."]);
		});

		it("«Видалити» у приваті прибирає ще й оригінальне повідомлення, з якого почалась сесія", async () => {
			const t = await started();
			await t.press(`del:${SESSION}`);
			expect(t.calls.filter((c) => c.method === "deleteMessage").map((c) => c.body)).toEqual([{ chat_id: OWNER, message_id: 100 }, { chat_id: OWNER, message_id: 7 }]);
		});

		it("«відповідь» передає номер варіанта агентові й показує вибране спливаючою підказкою", async () => {
			const t = await started();
			t.choices.set(SESSION, ["Мінімалізм", "Яскравий"]);
			await t.press(`ans:${SESSION}:1`);
			await t.press(`ans:${SESSION}:5`); // такого варіанта немає (чи питання вже закрите)
			await t.press(`tog:${SESSION}:0`);
			await t.press(`ok:${SESSION}`);
			expect(t.answers()).toEqual(["Відповідь: Яскравий", "Питання вже неактуальне.", "Відповідь: Мінімалізм", "Питання вже неактуальне."]);
		});

		it("чужий користувач, чужий чат, невідома дія чи сесія — відмова без наслідків", async () => {
			const t = await started();
			await t.press(`del:${SESSION}`, 999);
			await t.press(`del:${SESSION}`, OWNER, { id: -555, type: "channel" });
			await t.press("rm:everything");
			await t.press("del:tg-1-1");
			expect(t.sessions.has(SESSION)).toBe(true);
			expect(t.answers()).toEqual(["Недоступно.", "Недоступно.", "Невідома дія.", "Сесію не знайдено."]);
			expect(t.calls.filter((c) => c.method === "deleteMessage")).toEqual([]);
		});

		it("без секрету вебхука натискання не обробляється", async () => {
			const t = await started();
			const res = await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", body: JSON.stringify({ callback_query: { id: "x", from: { id: OWNER }, data: `del:${SESSION}` } }) }), env, { agent: t.agent, llm: t.llm, defer: () => {} });
			expect(res.status).toBe(401);
			expect(t.sessions.has(SESSION)).toBe(true);
		});
	});

	it("збій агента — повідомлення про помилку, а Telegram усе одно отримує 200", async () => {
		const { send, agent, replies } = setup();
		agent.begin = async () => {
			throw new Error("boom");
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await send(msg({ text: "задача" }))).status).toBe(200);
		expect(replies().at(-1)).toContain("Не вдалося створити сесію");
	});
});
