import type { McpFlags } from "./mcp";
import type { ImageRef, StartInput, WatchTarget } from "./types";

// Записи, які агент тримає про сесії (у Durable Object, але ядро цього не знає: воно бачить лише порт SessionStore).

// Прийняте завдання (begin/resume), яке виконує alarm. target немає в запитів із веб-API: стеження й підсумок у чат їм ні до чого.
export type Job = { id: string; target?: WatchTarget; attempts: number; queuedAt?: number; startedAt?: number } & ({ input: StartInput } | { text: string; images?: ImageRef[] });

// За сесією стежать, щоб повідомити в чат про завершення. seenBusy: чи бачили ми її працюючою (щойно запущена сесія ще може
// не з'явитись серед активних, тому без цього «вільна» означало б «ще не почала»).
export type Watch = WatchTarget & { ocId: string; since: number; seenBusy: boolean };

// Сесія агента в спільному контейнері: id сесії (наш ключ ідемпотентності) → сесія OpenCode і репозиторій.
// folder: назва теки (і гілки agent/<folder>); у старих записів немає, тоді це сам id.
// post: пост сесії в чаті, який агент оновлює на місці (стан, підсумок).
export type Tracked = { ocId: string; repo?: string; folder?: string; model?: string; post?: { postId: number; header: string; chatId?: number; url?: string; threadId?: number; title?: string } } & McpFlags;

// Сесія впала на лімітах Claude: чекаємо їх скидання, щоб написати в чат (лише для тих, хто справді впертися в ліміт).
export type LimitWait = WatchTarget & { since: number };
