// Whisper у Workers AI працює ~9x швидше за реальний час, а consumer має 15 хв wall time.
// 25 MB це ~50 хв аудіо iPhone (~64 kbps) або ~100 хв при 32 kbps, тобто з запасом.
export const TRANSCRIBE_MAX_BYTES = 25_000_000;

export const TELEGRAM_MAX_BYTES = 50_000_000; // ліміт Bot API на upload: 50 MB
