import type { ContentState } from "../../domain/note";
import type { PublishState } from "../../domain/published";
import type { SetupState } from "../setup";
import type { SyncState } from "../tasks";

// Проміжний стан обробки, зберігається в R2 поруч із записом (`<key>.state.json`): складається зі слайсів модулів.
// Дає ідемпотентність: повторна спроба не платить ще раз за Whisper/LLM
// і не шле в Telegram те, що вже відправлено.
export type State = ContentState & SetupState & SyncState & PublishState;
