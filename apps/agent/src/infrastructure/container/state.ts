import type { ImageRef, McpFlags, StartInput, WatchTarget } from "../../domain/agent";
import type { Choice } from "./activity";

// Що Durable Object тримає у сховищі і за якими ключами. Усі ключі й форми записів — тут, щоб модулі не вгадували їх самі.

// Прийняте завдання (begin/resume), яке виконує alarm. target немає в запитів із веб-API: стеження й підсумок у чат їм ні до чого.
export type Job = { id: string; target?: WatchTarget; attempts: number; queuedAt?: number; startedAt?: number } & ({ input: StartInput } | { text: string; images?: ImageRef[] });
export const jobKey = (id: string) => `job:${id}`;

// Питання агента, на яке можна відповісти кнопкою: форма й варіанти (callback_data несе лише номер варіанта).
export const FORM_PREFIX = "form:";
export type PendingForm = { askedAt?: number; formId: string; ocId: string; key: string; choices: Choice[]; multiple?: boolean; selected: number[]; text: string; next?: { key: string; choices: Choice[]; multiple?: boolean; text: string }[]; answers?: Record<string, string | boolean | string[]> };
export const formKey = (id: string) => `${FORM_PREFIX}${id}`;

// За сесією стежать, щоб повідомити в чат про завершення. seenBusy: чи бачили ми її працюючою (щойно запущена сесія ще може
// не з'явитись серед активних, тому без цього «вільна» означало б «ще не почала»).
export type Watch = WatchTarget & { ocId: string; since: number; seenBusy: boolean };
export const WATCH_PREFIX = "watch:";
export const watchKey = (id: string) => `${WATCH_PREFIX}${id}`;
export const watchId = (key: string) => key.slice(WATCH_PREFIX.length);

// Знімок прив'язаний до образу, з якого створений: після зміни образу його відновити не можна.
export type SavedSnapshot = { id: string; image: string; at: number };

// Сесія агента в спільному контейнері: id сесії (наш ключ ідемпотентності) → сесія OpenCode і репозиторій.
// folder: назва теки (і гілки agent/<folder>); у старих записів немає, тоді це сам id.
// post: пост сесії в чаті, який агент оновлює на місці (стан, підсумок).
export type Tracked = { ocId: string; repo?: string; folder?: string; model?: string; post?: { postId: number; header: string; chatId?: number; url?: string; threadId?: number; title?: string } } & McpFlags;
export const SESSION_PREFIX = "session:";
export const sessionKey = (id: string) => `${SESSION_PREFIX}${id}`;
export const sessionId = (key: string) => key.slice(SESSION_PREFIX.length);
export const sessionDir = (folder: string) => `/workspace/sessions/${folder}`;

// Останній показаний у пості стан, щоб вебхук GitHub міг перемалювати пост з деплоєм.
export type LastShown = { status: string; final: boolean; mergeable: boolean };
export const deployKey = (postId: number) => `deploy:${postId}`;
export const lastKey = (postId: number) => `last:${postId}`;
export const refKey = (key: string) => `ref:${key}`;

// Сесія впала на лімітах Claude: чекаємо їх скидання, щоб написати в чат (лише для тих, хто справді впертися в ліміт).
export type LimitWait = WatchTarget & { since: number };
export const LIMIT_PREFIX = "limit:";
export const limitKey = (id: string) => `${LIMIT_PREFIX}${id}`;

// Ключі стану контейнера (Computer): знімок диска, відбиток розкладеного payload, образ, з якого він запущений, і мітки активності.
export const computerKey = { snapshot: "snapshot", payloadHash: "payloadHash", launchedImage: "launchedImage", activeAt: "activeAt", usedAt: "usedAt" } as const;
