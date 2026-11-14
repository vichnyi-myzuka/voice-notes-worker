/// <reference types="node" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Тимчасові теки тестів видаляються після файлу: на диску контейнера вони потрапляли б у кожен знімок (один прогін publish-тесту
// лишав ~50 МБ, а їх за день набігали тисячі).
const made: string[] = [];

export function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
