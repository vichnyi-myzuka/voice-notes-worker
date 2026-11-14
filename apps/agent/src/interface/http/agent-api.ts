import { safeEqual } from "@voice-notes/core";
import { denyUnlessAccess } from "./access";
import type { NewSchedule, Outcome, SchedulePatch, Schedules } from "../../domain/schedule";
import type { Env } from "../../env";
import { sessionToken } from "../../infrastructure/session-token";

export const AGENT_API_PATH = "/agent-api/schedules";

const FOLDER = /^[\w.-]{1,100}$/;
const SCHEDULE_ID = /^[a-f0-9]{8}$/;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const STATUS = { invalid: 400, limit: 409, not_found: 404 } as const;
const outcome = <T>(o: Outcome<T>) => (o.ok ? json({ schedule: o.value }) : json({ error: o.error }, STATUS[o.code]));

// API розкладів для агента всередині контейнера (команда `schedule`). Шлях лишається за Cloudflare Access: контейнер не проходить
// логін, тож іде з Service Token (заголовки CF-Access-Client-Id/Secret, ADR 0003), а воркер ще й перевіряє JWT Access. Поверх цього
// секрет сесії в `authorization: Bearer`, назва теки сесії в `x-session-folder`. Агент може лише пропонувати: нові розклади й зміни стають `pending`, і їх активує власник кнопкою в Telegram.
//   GET /agent-api/schedules, POST /agent-api/schedules, PATCH|DELETE /agent-api/schedules/<id>
export async function handleAgentApi(req: Request, env: Env, schedules: Schedules): Promise<Response> {
	const denied = await denyUnlessAccess(req, env);
	if (denied) return denied;
	const folder = req.headers.get("x-session-folder") ?? "";
	const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
	if (!FOLDER.test(folder) || !bearer || !(await safeEqual(bearer, await sessionToken(env.OPENCODE_PASSWORD, folder)))) return json({ error: "unauthorized" }, 401);

	const url = new URL(req.url);
	const id = url.pathname.slice(AGENT_API_PATH.length).replace(/^\//, "");
	if (!id) {
		if (req.method === "GET") return json({ schedules: await schedules.list() });
		if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
		const body = await req.json<NewSchedule>().catch(() => null);
		if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
		return outcome(await schedules.create(body, "agent", url.origin));
	}
	if (!SCHEDULE_ID.test(id)) return json({ error: "bad id" }, 400);
	if (req.method === "DELETE") return (await schedules.remove(id)) ? json({ ok: true }) : json({ error: "no such schedule" }, 404);
	if (req.method === "PATCH") {
		const body = await req.json<SchedulePatch>().catch(() => null);
		if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);
		return outcome(await schedules.update(id, body, "agent"));
	}
	return json({ error: "method not allowed" }, 405);
}
