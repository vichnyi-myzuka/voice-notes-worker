import { type Channel, type Llm } from "@voice-notes/core";
import type { ContentState } from "../../domain/note";
import type { RecordingStore } from "../../domain/recording";
import type { NoteRepository, PublishState } from "../../domain/published";
import type { IssueLedger, IssueTracker } from "../../domain/issues";
import type { TaskLedger, TaskTracker } from "../../domain/tracker";
import type { IssueState } from "../issues";
import type { SetupState } from "../setup";
import type { SyncState } from "../tasks";

// Проміжний стан обробки, зберігається в R2 поруч із записом (`<key>.state.json`): складається зі слайсів модулів.
// Дає ідемпотентність: повторна спроба не платить ще раз за Whisper/LLM
// і не шле в Telegram те, що вже відправлено.
export type State = ContentState & SetupState & SyncState & IssueState & PublishState;

// Зовнішні системи, з якими працює конвеєр: куди публікуємо нотатки, де ведемо задачі та issues і де це зберігаємо (записи, нотатки, задачі).
export type Ports = { channel: Channel; tracker: TaskTracker; notes: NoteRepository; recordings: RecordingStore; ledger: TaskLedger; issues: IssueTracker; issueLedger: IssueLedger; llm: Llm };
