import type { Env } from "../../env";
import type { Computer } from "./computer";
import { STREAM_MAX_MS } from "./config";
import { OPENCODE_PORT, basicAuth } from "./opencode";

// Веб-інтерфейс OpenCode: запити (разом із SSE) проксуються в контейнер.
export class WebProxy {
	// Відкриті зараз SSE-потоки (лише для діагностики).
	private streams = new Map<number, { path: string; openedAt: number }>();
	private streamSeq = 0;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
		private readonly computer: Computer,
	) {}

	open(): { path: string; openedAt: number }[] {
		return [...this.streams.values()];
	}

	// onPrompted: повідомлення з веб-інтерфейсу в сесію OpenCode (id сесії) вдалося — за нею треба почати стежити.
	async handle(request: Request, onPrompted: (ocId: string) => Promise<void>): Promise<Response> {
		// Потік подій забутої вкладки не будить сплячий контейнер (204: EventSource не перепідключається); будить звичайний запит сторінки.
		const sse = (request.headers.get("accept") ?? "").includes("text/event-stream");
		if (sse && !this.computer.running) return new Response(null, { status: 204 });
		await this.computer.ensureRunning();
		// Зміни з веб-інтерфейсу (повідомлення, правки) теж треба зберегти; читання й SSE — ні.
		if (!["GET", "HEAD"].includes(request.method)) await this.computer.markActive();
		const promptedOc = request.method === "POST" ? new URL(request.url).pathname.match(/^\/api\/session\/([^/]+)\/prompt$/)?.[1] : undefined;
		const url = new URL(request.url);
		const headers = new Headers(request.headers);
		headers.set("authorization", basicAuth(this.env.OPENCODE_PASSWORD));
		headers.delete("host");
		headers.delete("cookie"); // cookie Access контейнеру не потрібні
		// OpenCode відхиляє запити термінала (connect-token, WebSocket), якщо Origin не збігається з Host контейнера; без Origin
		// (як у не-браузерних клієнтів) перевірка проходить. Доступ уже захищено Access і паролем.
		headers.delete("origin");
		const upstream = new Request(`http://container${url.pathname}${url.search}`, new Request(request, { headers })) as unknown as Request<unknown, CfProperties>;
		const port = this.ctx.container!.getTcpPort(OPENCODE_PORT);
		if (!sse) {
			const res = await port.fetch(upstream);
			if (promptedOc && res.ok) await onPrompted(promptedOc).catch((err) => console.error("watch of web prompt failed:", err));
			return res;
		}

		// SSE: обмежуємо час життя потоку й ведемо облік для діагностики.
		const id = ++this.streamSeq;
		this.streams.set(id, { path: url.pathname, openedAt: Date.now() });
		const stop = new AbortController();
		const done = () => {
			clearTimeout(timer);
			this.streams.delete(id);
		};
		const timer = setTimeout(() => {
			stop.abort();
			done();
		}, STREAM_MAX_MS);
		request.signal.addEventListener("abort", () => {
			stop.abort();
			done();
		});
		return port.fetch(new Request(upstream, { signal: stop.signal }) as unknown as Request<unknown, CfProperties>);
	}
}
