import { afterEach, describe, expect, it, vi } from "vitest";
import { extractImages, loadImages, sendImages } from "../src/infrastructure/container/images";

afterEach(() => vi.unstubAllGlobals());

describe("extractImages", () => {
	it("забирає зображення з тексту й лишає решту", () => {
		const r = extractImages("Готово.\n\n![Графік](/workspace/sessions/a/chart.png)\n\nПосилання: [PR](https://github.com/x)");
		expect(r.images).toEqual([{ source: "/workspace/sessions/a/chart.png", caption: "Графік" }]);
		expect(r.text).toBe("Готово.\n\nПосилання: [PR](https://github.com/x)");
	});
	it("https-адреса приймається, відносні шляхи й інші розширення — ні (лишаються в тексті)", () => {
		const r = extractImages("![a](https://x.test/a.png) ![b](rel/b.png) ![c](/etc/passwd)");
		expect(r.images).toEqual([{ source: "https://x.test/a.png", caption: "a" }]);
		expect(r.text).toContain("![b](rel/b.png)");
		expect(r.text).toContain("![c](/etc/passwd)");
	});
	it("не більше п'яти зображень", () => {
		const text = Array.from({ length: 7 }, (_, i) => `![](/tmp/${i}.png)`).join("\n");
		expect(extractImages(text).images).toHaveLength(5);
	});
	it("без зображень текст не змінюється", () => {
		expect(extractImages("Просто\n\n\n\nтекст")).toEqual({ text: "Просто\n\n\n\nтекст", images: [] });
	});
});

describe("loadImages", () => {
	it("завантажує файл з Telegram і віддає data:-посилання", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/file/bot") ? new Response(new Uint8Array([1, 2, 3])) : Response.json({ ok: true, result: { file_path: "photos/a.jpg" } }))));
		const files = await loadImages({ BOT_TOKEN: "t" }, [{ fileId: "f", mime: "image/jpeg" }]);
		expect(files).toEqual([{ uri: "data:image/jpeg;base64,AQID", name: "telegram-1.jpg" }]);
	});
});

describe("sendImages", () => {
	it("файл з контейнера йде як multipart sendPhoto у тему, недоступний пропускається", async () => {
		const sent: { url: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (sent.push({ url, body: init.body }), Response.json({ ok: true, result: { message_id: 1 } }))));
		const read = vi.fn(async (p: string) => (p.endsWith("ok.png") ? new Uint8Array([9]) : undefined));
		await sendImages({ BOT_TOKEN: "t" }, 5, [{ source: "/tmp/no.png", caption: "" }, { source: "/tmp/ok.png", caption: "Підпис" }, { source: "https://x.test/a.png", caption: "" }], read, 77);
		expect(sent).toHaveLength(2);
		const form = sent[0].body as FormData;
		expect(sent[0].url).toContain("/sendPhoto");
		expect([form.get("chat_id"), form.get("message_thread_id"), form.get("caption")]).toEqual(["5", "77", "Підпис"]);
		expect(form.get("photo")).toBeInstanceOf(Blob);
		expect(JSON.parse(sent[1].body as string)).toMatchObject({ photo: "https://x.test/a.png", message_thread_id: 77 });
	});
});
