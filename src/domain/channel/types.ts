// Посилання всередині тексту: діапазон у UTF-16, як і довжина рядків у JS.
export type TextLink = { offset: number; length: number; url: string };

// Запис, який треба опублікувати: тіло (для завантаження в канал) і службові дані каналу,
// що лежать в R2 разом із записом (ядро їх не розуміє).
export type Recording = { blob: () => Promise<Blob>; metadata?: Record<string, string> };

// Що канал повідомляє про прийнятий запис: службові дані зберігаються разом із записом,
// `origin` — як прибрати оригінальне повідомлення (є лише в каналах, де його видно іншим).
export type Incoming = {
	contentType: string;
	caption?: string; // підпис до фото
	replyTo?: string; // відповідь на нотатку: id її повідомлення в каналі
	metadata: Record<string, string>;
	origin?: Record<string, string>;
};

// Кладе прийнятий запис у сховище й чергу. Повертає false, якщо оригінал уже прибрано (правка).
export type OnIncoming = (key: string, body: ArrayBuffer, incoming: Incoming) => Promise<boolean>;

// Канал, яким нотатки приходять і публікуються (зараз Telegram). Ядро знає лише цей інтерфейс.
export interface Channel {
	// Скільки тексту влізає в підпис до запису і в текстову нотатку (решта — під цитату оригіналу).
	limits: { caption: number; textNote: number };
	// Шлях, на якому канал приймає вхідні запити (вебхук), і сам обробник.
	webhookPath: string;
	webhook: (req: Request, onIncoming: OnIncoming) => Promise<Response>;
	// Посилання на опубліковану нотатку; null, якщо канал його не вміє.
	linkTo: (messageId: number) => string | null;
	publishRecording: (recording: Recording, title: string, caption: string) => Promise<number>;
	publishText: (caption: string, original: string) => Promise<number>;
	// Оновлює опубліковану нотатку; original — для текстової нотатки.
	update: (messageId: number, caption: string, links: TextLink[], original?: string) => Promise<void>;
	remove: (messageId: number) => Promise<void>;
	// Позначає нотатку як «редагується».
	setBusy: (messageId: number, busy: boolean) => Promise<void>;
	removeOrigin: (metadata: Record<string, string> | undefined) => Promise<void>;
	// Повідомлення власнику (помилки й підказки).
	say: (text: string) => Promise<void>;
}
