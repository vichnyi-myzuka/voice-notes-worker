export type { Job, LimitWait, PendingForm, Tracked, Watch } from "../../../domain/agent";

// Що Durable Object тримає у сховищі і за якими ключами. Усі ключі й форми записів — тут, щоб модулі не вгадували їх самі.

export const jobKey = (id: string) => `job:${id}`;

// Питання агента (форма): тип запису — domain/agent/records.ts, ключ form:<id сесії>.
export const FORM_PREFIX = "form:";
export const formKey = (id: string) => `${FORM_PREFIX}${id}`;

export const WATCH_PREFIX = "watch:";
export const watchKey = (id: string) => `${WATCH_PREFIX}${id}`;
export const watchId = (key: string) => key.slice(WATCH_PREFIX.length);

// Знімок прив'язаний до образу, з якого створений: після зміни образу його відновити не можна.
export type SavedSnapshot = { id: string; image: string; at: number };

export const SESSION_PREFIX = "session:";
export const sessionKey = (id: string) => `${SESSION_PREFIX}${id}`;
export const sessionId = (key: string) => key.slice(SESSION_PREFIX.length);
export const sessionDir = (folder: string) => `/workspace/sessions/${folder}`;

// Стан поста сесії (тип LastShown — у domain): деплой, останній показаний стан і пости для вебхука GitHub.
export const deployKey = (postId: number) => `deploy:${postId}`;
export const lastKey = (postId: number) => `last:${postId}`;
export const refKey = (key: string) => `ref:${key}`;

export const LIMIT_PREFIX = "limit:";
export const limitKey = (id: string) => `${LIMIT_PREFIX}${id}`;

// Ключі стану контейнера (Computer): знімок диска, відбиток розкладеного payload, образ, з якого він запущений, і мітки активності.
export const computerKey = { snapshot: "snapshot", payloadHash: "payloadHash", launchedImage: "launchedImage", activeAt: "activeAt", usedAt: "usedAt" } as const;
