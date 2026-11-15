import { tg } from "@voice-notes/core";
import type { PostChat } from "../../../domain/agent";
import type { ChatEnv } from "../../../env";
import { editChat, renameTopic, setTopicIcon } from "../../chat";

// Адаптер PostChat до Telegram: пост сесії — повідомлення в чаті, тема — тема форуму.
export const telegramPosts = (env: ChatEnv): PostChat => ({
	enabled: !!env.BOT_TOKEN,
	edit: (p) => editChat({ BOT_TOKEN: env.BOT_TOKEN! }, p.chatId, p.postId, p.text, p.session, p.buttons, p.answers, p.review),
	react: async (chatId, postId, on) => {
		await tg({ BOT_TOKEN: env.BOT_TOKEN! }, "setMessageReaction", { chat_id: chatId, message_id: postId, reaction: on ? [{ type: "emoji", emoji: "👨‍💻" }] : [] }).catch((err) => console.error("reaction failed:", err));
	},
	setIcon: (chatId, threadId, state) => setTopicIcon({ BOT_TOKEN: env.BOT_TOKEN! }, chatId, threadId, state),
	rename: (chatId, threadId, title) => renameTopic({ BOT_TOKEN: env.BOT_TOKEN! }, chatId, threadId, title),
});
