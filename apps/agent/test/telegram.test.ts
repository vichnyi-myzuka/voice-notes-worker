import { afterEach, describe, expect, it, vi } from "vitest";
import type { Llm } from "@voice-notes/core";
import type { Env } from "../src/env";
import { handleTelegram, parseRepos } from "../src/interface/telegram";
import { describe as describeReport } from "../src/interface/telegram/commands";
import { EPHEMERAL_MS } from "../src/infrastructure/chat";
import { fakeAgent } from "./fake-agent";

// timingSafeEqual є лише в workerd: у Node мокаємо порівняння (мок за шляхом файлу в core).
vi.mock("../../../packages/core/src/infrastructure/security", () => ({ safeEqual: async (a: string, b: string) => a === b }));

const env = { BOT_TOKEN: "bot", TG_WEBHOOK_SECRET: "secret", TG_OWNER_ID: "42", CHAT_ID: "-1001" } as unknown as Env;
const OWNER = 42;
const TEMP_ID = 500; // message_id, який мок Telegram віддає службовим відповідям з 💨
const CHANNEL = -1001;

// Telegram Bot API на підміненому fetch: запам'ятовує виклики методів і віддає файл для getFile.
function setup(transcript = "Поправ README", pick?: (user: string) => { repo?: string; type?: string; name?: string; title?: string; model?: string; unsure?: boolean } | null) {
	const agent = fakeAgent();
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	const topics = { id: 0 }; // id теми, яку «створює» Telegram; 0 — теми не підтримуються (як у чаті без режиму тем)
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			if (input.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
			const method = input.split("/").pop()!;
			calls.push({ method, body: JSON.parse(init!.body as string) });
			if (method === "createForumTopic" && !topics.id) return new Response("not a forum", { status: 400 });
			return Response.json({ ok: true, result: method === "createForumTopic" ? { message_thread_id: topics.id } : method === "getFile" ? { file_path: "voice/a.oga" } : { message_id: method === "sendMessage" && String(JSON.parse(init!.body as string).text).endsWith(" 💨") ? TEMP_ID : 1 } });
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
	return { ...agent, llm, sleep, send, press, answers, calls, replies, topics };
}

const post = (extra: Record<string, unknown>, id = 9) => ({ message_id: id, date: 1, chat: { id: CHANNEL, type: "channel" }, ...extra });
const msg = (extra: Record<string, unknown>, id = 7) => ({ message_id: id, date: 1, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, ...extra });

afterEach(() => vi.unstubAllGlobals());

describe("меню команд", () => {
	it("setMyCommands виставляється з першим вебхуком, збій повторюється, успішний — не повторюється", async () => {
		const { agent, llm, calls } = setup();
		const fetchMock = vi.mocked(fetch);
		const pending: Promise<unknown>[] = [];
		const ping = async () => {
			await handleTelegram(new Request("https://agent.example/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret" }, body: JSON.stringify({ update_id: 1 }) }), env, { agent, llm, defer: (w) => void pending.push(w), syncCommands: true });
			await Promise.all(pending.splice(0));
		};
		fetchMock.mockImplementationOnce(async () => Response.json({ ok: false, description: "boom" }, { status: 500 }));
		await ping(); // збій
		await ping(); // повтор успішний
		await ping(); // вже виставлено
		const sets = calls.filter((c) => c.method === "setMyCommands");
		expect(sets).toHaveLength(1);
		expect(sets[0].body).toMatchObject({ scope: { type: "all_private_chats" } });
		expect((sets[0].body.commands as { command: string }[]).map((c) => c.command)).toEqual(["status", "stop", "model", "delete", "automations", "quota", "update"]);
	});
});

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
		expect(llm.transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), "audio/ogg", expect.stringContaining("Opus"));
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

		it("«@opus задача» задає модель нової сесії (разом з репозиторієм), префікс не потрапляє в задачу", async () => {
			const { send, sessions } = setup();
			await send(msg({ text: "@opus acme/site: Поправ README" }));
			expect(sessions.get(SID)?.input).toMatchObject({ prompt: "Поправ README", repo: "acme/site", model: "opus" });
		});

		it("голосове чи текст «модель опус, задача» теж задає модель; невідома назва лишається в задачі", async () => {
			const a = setup();
			await a.send(msg({ text: "Модель Опус, поправ README" }));
			expect(a.sessions.get(SID)?.input).toMatchObject({ prompt: "поправ README", model: "opus" });
			const b = setup();
			await b.send(msg({ text: "Модель користувача поправ README" }));
			expect(b.sessions.get(SID)?.input.model).toBeUndefined();
			expect(b.sessions.get(SID)?.input.prompt).toBe("Модель користувача поправ README");
		});

		it("модель зі середини фрази (спотворена розпізнаванням: «опис») бере роутер; явний префікс сильніший; «none» і невідоме ігноруються", async () => {
			const phrase = "Що може покращити розпізнавання, використай модель опис";
			const a = setup("", () => ({ model: "opus", type: "docs", name: "voice-hints" }));
			await a.send(msg({ text: phrase }));
			expect(a.sessions.get(SID)?.input).toMatchObject({ prompt: phrase, model: "opus" });
			expect(a.replies()[0]).toContain("🤖 opus");
			const b = setup("", () => ({ model: "opus", name: "voice-hints" }));
			await b.send(msg({ text: "@haiku " + phrase }));
			expect(b.sessions.get(SID)?.input.model).toBe("haiku");
			for (const model of ["none", "gpt-9"]) {
				const c = setup("", () => ({ model, name: "voice-hints" }));
				await c.send(msg({ text: phrase }));
				expect(c.sessions.get(SID)?.input.model).toBeUndefined();
			}
		});

		it("явне «сільпо, задача» / «@silpo задача» вмикає MCP Сільпо (окремо й разом зі Sure, з моделлю в будь-якому порядку)", async () => {
			const a = setup();
			await a.send(msg({ text: "Сільпо, що я купував минулого тижня" }));
			expect(a.sessions.get(SID)?.input).toMatchObject({ prompt: "що я купував минулого тижня", silpo: true });
			expect(a.sessions.get(SID)?.input.sure).toBeUndefined();
			const b = setup();
			await b.send(msg({ text: "модель опус, @silpo шур, зістав чеки з платежами" }));
			expect(b.sessions.get(SID)?.input).toMatchObject({ prompt: "зістав чеки з платежами", model: "opus", sure: true, silpo: true });
			expect(JSON.stringify(a.calls.map((c) => c.body))).toContain("https://agent.example/silpo/login");
		});

		it("задачі зі Sure чи Сільпо за замовчуванням на haiku, явна модель сильніша", async () => {
			const a = setup();
			await a.send(msg({ text: "Шур, скільки я витратив у жовтні" }));
			expect(a.sessions.get(SID)?.input.model).toBe("haiku");
			const b = setup();
			await b.send(msg({ text: "Сільпо, що я купував" }));
			expect(b.sessions.get(SID)?.input.model).toBe("haiku");
			const c = setup();
			await c.send(msg({ text: "@opus шур, покажи бюджет" }));
			expect(c.sessions.get(SID)?.input.model).toBe("opus");
		});

		it("явне «шур, задача» / «@sure задача» вмикає MCP Sure для сесії (разом із моделлю в будь-якому порядку)", async () => {
			const a = setup();
			await a.send(msg({ text: "Шур, скільки я витратив у жовтні" }));
			expect(a.sessions.get(SID)?.input).toMatchObject({ prompt: "скільки я витратив у жовтні", sure: true });
			const b = setup();
			await b.send(msg({ text: "модель опус, @sure покажи бюджет" }));
			expect(b.sessions.get(SID)?.input).toMatchObject({ prompt: "покажи бюджет", model: "opus", sure: true });
			const c = setup();
			await c.send(msg({ text: "Sure, поправ README" }));
			expect(c.sessions.get(SID)?.input.sure).toBeUndefined();
		});

		it("Sure вмикає й висновок моделі про фінанси власника без жодного ключового слова; інакше MCP не підключається", async () => {
			const yes = setup("", (user) => (user.includes("мої фінанси") ? { repo: "none", type: "feat", name: "finance-check", finance: true } : null));
			await yes.send(msg({ text: "Хочу перевірити мої фінанси за жовтень" }));
			expect(yes.sessions.get(SID)?.input).toMatchObject({ prompt: "Хочу перевірити мої фінанси за жовтень", sure: true });
			const no = setup("", () => ({ repo: "none", type: "feat", name: "finance-page", finance: false }));
			await no.send(msg({ text: "Зроби сторінку калькулятора фінансів" }));
			expect(no.sessions.get(SID)?.input.sure).toBeUndefined();
		});

		it("/model змінює модель відповіддю на пост; без відповіді чи з недоступною моделлю — підказка", async () => {
			const { send, sessions, replies } = await withSession();
			await send(msg({ text: "/model opus", reply_to_message: botPost() }, 8));
			expect(sessions.get(SID)?.input.model).toBe("opus");
			await send(msg({ text: "/model nope", reply_to_message: botPost() }, 9));
			await send(msg({ text: "/model" }, 10));
			expect(replies()[0]).toContain("Модель сесії: opus");
			expect(replies()[1]).toContain("недоступна");
			expect(replies()[2]).toContain("/model <модель>");
		});

		it("/delete видаляє сесію й пост; наступні команди бачать, що її немає", async () => {
			const { send, sessions, replies } = await withSession();
			await send(msg({ text: "/delete", reply_to_message: botPost() }, 8));
			expect(sessions.has(SID)).toBe(false);
			await send(msg({ text: "/status", reply_to_message: botPost() }, 9));
			expect(replies()).toEqual(["⚠️ Сесію не знайдено."]); // про саме видалення бот мовчить
		});

		describe("вибір репозиторію кнопками", () => {
			const vague = "Покращимо розпізнавання в проєкті";
			const unsure = () => ({ unsure: true, type: "feat", name: "recognition" });
			const keyboard = (calls: { method: string; body: Record<string, unknown> }[]) => (calls.find((c) => c.method === "sendMessage")!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard.flat();

			it("роутер не впевнений: сесії ще немає, питання з кнопками (репозиторії + «Без репозиторію»)", async () => {
				const { send, sessions, calls } = setup("", unsure);
				await send(msg({ text: vague }));
				expect(sessions.size).toBe(0);
				expect(keyboard(calls).map((b) => b.text)).toEqual(["📦 me/bot", "📦 me/site", "Без репозиторію"]);
				expect(keyboard(calls).map((b) => b.callback_data)).toEqual([`pick:${SID}:0`, `pick:${SID}:1`, `pick:${SID}:-`]);
			});

			it("натискання запускає сесію з вибраним репозиторієм (задача й назва збережені), друге натискання неактуальне", async () => {
				const { send, press, sessions, answers, calls } = setup("", unsure);
				await send(msg({ text: vague }));
				await press(`pick:${SID}:1`);
				expect(sessions.get(SID)?.input).toMatchObject({ prompt: vague, repo: "me/site", name: "feat-recognition" });
				expect(calls.some((c) => c.method === "deleteMessage")).toBe(true); // питання з кнопками прибрано
				await press(`pick:${SID}:0`);
				expect(answers()).toEqual(["Запускаю.", "Вибір уже неактуальний."]);
				expect(sessions.get(SID)?.input.repo).toBe("me/site");
			});

			it("«Без репозиторію» запускає сесію без repo; чужий номер і чужа людина нічого не запускають", async () => {
				const a = setup("", unsure);
				await a.send(msg({ text: vague }));
				await a.press(`pick:${SID}:-`);
				expect(a.sessions.get(SID)?.input.repo).toBeUndefined();
				const b = setup("", unsure);
				await b.send(msg({ text: vague }));
				await b.press(`pick:${SID}:5`);
				await b.press(`pick:${SID}:0`, 999);
				expect(b.sessions.size).toBe(0);
				expect(b.answers()).toEqual(["Вибір уже неактуальний.", "Недоступно."]);
			});

			it("явний репозиторій у фразі чи впевнений роутер: питання не потрібне", async () => {
				const a = setup("", unsure);
				await a.send(msg({ text: "acme/site: " + vague }));
				expect(a.sessions.get(SID)?.input.repo).toBe("acme/site");
				const b = setup("", () => ({ unsure: true, repo: "me/bot", evidence: "боті", name: "x" }));
				await b.send(msg({ text: "Що в нашому боті можна покращити" }));
				expect(b.sessions.get(SID)?.input.repo).toBe("me/bot");
			});
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
				expect(parseRepos('[{"repo":"a/b","about":"x","site":"my-game"},{"repo":"c/d","about":"y","site":"Bad Name"}]')).toEqual([{ repo: "a/b", about: "x", site: "my-game" }, { repo: "c/d", about: "y" }]);
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

	describe("теми приватного чату", () => {
		const SID = `tg-${OWNER}-7`;
		const THREAD = 555;

		it("нова сесія з головного чату отримує тему: пост іде в неї, оригінал прибирається, тема в спостереженні", async () => {
			const t = setup();
			t.topics.id = THREAD;
			await t.send(msg({ text: "Поправ README" }));
			expect(t.calls.find((c) => c.method === "createForumTopic")!.body).toMatchObject({ chat_id: OWNER });
			const sent = t.calls.find((c) => c.method === "sendMessage")!.body;
			expect(sent).toMatchObject({ message_thread_id: THREAD });
			expect(sent.text).toContain("Поправ README"); // оригінал зникає, тож задача в пості
			expect(t.calls.filter((c) => c.method === "deleteMessage").map((c) => c.body)).toEqual([{ chat_id: OWNER, message_id: 7 }]);
			expect(t.watches[0].target).toMatchObject({ chatId: OWNER, postId: 1, threadId: THREAD });
		});

		it("тема отримує семантичну назву від моделі, яка запам'ятовується для подальших оновлень", async () => {
			const t = setup("Поправ README", () => ({ repo: "none", type: "docs", name: "readme", title: " Виправлення README. " }));
			t.topics.id = THREAD;
			await t.send(msg({ text: "Поправ README" }));
			expect(t.calls.find((c) => c.method === "createForumTopic")!.body).toMatchObject({ name: "Виправлення README" });
			expect(t.watches[0].target).toMatchObject({ threadId: THREAD, title: "Виправлення README" });
		});

		it("теми не підтримуються (збій createForumTopic): усе як раніше, у самому чаті", async () => {
			const t = setup();
			await t.send(msg({ text: "Поправ README" }));
			expect(t.calls.find((c) => c.method === "sendMessage")!.body).not.toHaveProperty("message_thread_id");
			expect(t.calls.some((c) => c.method === "deleteMessage")).toBe(false);
			expect(t.watches[0].target).not.toHaveProperty("threadId");
		});

		it("повідомлення в темі без reply — уточнення в сесію цієї теми; відповіді бота йдуть у ту ж тему", async () => {
			const t = setup();
			t.topics.id = THREAD;
			await t.send(msg({ text: "Поправ README" }));
			t.calls.length = 0;
			await t.send(msg({ text: "Ще й CHANGELOG", message_thread_id: THREAD }, 8));
			expect(t.sessions.size).toBe(1);
			expect(t.sessions.get(SID)?.messages).toEqual(["Поправ README", "Ще й CHANGELOG"]);
			expect(t.calls.some((c) => c.method === "createForumTopic")).toBe(false);
			await t.send(msg({ text: "/status", message_thread_id: THREAD }, 9));
			expect(t.calls.filter((c) => c.method === "sendMessage").map((c) => c.body)).toEqual([expect.objectContaining({ message_thread_id: THREAD, text: expect.stringContaining("Працює") })]);
		});

		it("повідомлення в темі, що не належить сесії, стартує сесію в ній без нової теми", async () => {
			const t = setup();
			t.topics.id = THREAD;
			await t.send(msg({ text: "Поправ README", message_thread_id: 999 }));
			expect(t.calls.some((c) => c.method === "createForumTopic")).toBe(false);
			expect(t.calls.find((c) => c.method === "sendMessage")!.body).toMatchObject({ message_thread_id: 999 });
			expect(t.watches[0].target).toMatchObject({ threadId: 999 });
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

describe("зображення від власника", () => {
	it("фото з підписом стає сесією з вкладенням; Whisper не викликається, оригінал замінюється постом із підписом", async () => {
		const t = setup();
		await t.send(msg({ photo: [{ file_id: "small", file_size: 10 }, { file_id: "big", file_size: 99 }], caption: "Що тут не так?" }, 31));
		const s = t.sessions.get("tg-42-31")!;
		expect(s.input).toMatchObject({ prompt: "Що тут не так?", images: [{ fileId: "big", mime: "image/jpeg" }] });
		expect(t.llm.transcribe).not.toHaveBeenCalled();
		expect(t.calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 31)).toBe(true);
		expect(t.calls.find((c) => c.method === "sendMessage" && String(c.body.text).includes("Що тут не так?"))).toBeTruthy();
	});

	it("фото без підпису: задача за замовчуванням; зображення-документ приймається, інший документ — ні", async () => {
		const t = setup();
		await t.send(msg({ document: { file_id: "d1", mime_type: "image/png", file_size: 5 } }, 32));
		expect(t.sessions.get("tg-42-32")!.input).toMatchObject({ prompt: expect.stringContaining("зображення"), images: [{ fileId: "d1", mime: "image/png" }] });
		await t.send(msg({ document: { file_id: "d2", mime_type: "application/pdf" } }, 33));
		expect(t.sessions.has("tg-42-33")).toBe(false);
	});

	it("відповідь фото на пост сесії — уточнення з вкладенням", async () => {
		const t = setup();
		await t.send(msg({ text: "Зроби" }, 40));
		const id = "tg-42-40";
		await t.send(msg({ photo: [{ file_id: "p", file_size: 1 }], caption: "Ось макет", reply_to_message: { message_id: 1, text: `x https://agent.example/s/${id}` } }, 41));
		const s = t.sessions.get(id)!;
		expect(s.messages.at(-1)).toBe("Ось макет");
		expect(s.images).toEqual([{ fileId: "p", mime: "image/jpeg" }]);
		expect(t.calls.some((c) => c.method === "deleteMessage" && c.body.message_id === 41)).toBe(true); // як і інші уточнення
	});
});
