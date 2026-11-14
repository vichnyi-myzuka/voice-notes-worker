#!/usr/bin/env node
// Автоматизації агента (ADR 0005): `schedule list | add | edit <id> | delete <id>`. Команда викликає API воркера з секретом сесії;
// адреса й секрет лежать у /root/.agent/schedule/<тека сесії>.json (кладе session-prep). Тека сесії береться з cwd (/workspace/sessions/<тека>/...).
// Нові розклади й зміни агент лише пропонує: власник активує їх кнопкою в Telegram, поки не підтвердить — статус `pending`.
const fs = require("fs");

const USAGE = `usage:
  schedule list
  schedule add --name <name> --prompt <text> (--at <ISO date-time with offset> | --cron "<m h dom mon dow>" [--tz <IANA zone>]) [--repo owner/name] [--model <model>] [--max-cost <USD>] [--expires <ISO date-time>]
  schedule edit <id> [--name ..] [--prompt ..] [--at .. | --cron .. [--tz ..]] [--repo ..] [--model ..] [--expires ..]
  schedule delete <id>`;
const die = (msg, code = 1) => (console.error(msg), process.exit(code));

const m = /^\/workspace\/sessions\/([^/]+)/.exec(process.cwd());
if (!m) die("schedule: run it from your session directory (/workspace/sessions/<name>)");
const folder = m[1];
let conf;
try {
	conf = JSON.parse(fs.readFileSync(`/root/.agent/schedule/${folder}.json`, "utf8"));
} catch {
	die("schedule: not available in this session (no API credentials). Start a new session and try again.");
}

const [cmd, ...rest] = process.argv.slice(2);
const FLAGS = { name: "name", prompt: "prompt", at: "at", cron: "cron", tz: "tz", repo: "repo", model: "model", expires: "expiresAt", "max-cost": "maxCostUsd" };
function parse(args) {
	const body = {};
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
		const key = FLAGS[a.slice(2)];
		if (!key || args[i + 1] === undefined) die(`schedule: bad option ${a}\n${USAGE}`, 2);
		body[key] = key === "maxCostUsd" ? Number(args[++i]) : args[++i];
	}
	return { body, positional };
}

async function call(method, path, body) {
	const res = await fetch(`${conf.url}/agent-api/schedules${path}`, {
		method,
		headers: { authorization: `Bearer ${conf.token}`, "x-session-folder": folder, ...(conf.clientId && { "CF-Access-Client-Id": conf.clientId, "CF-Access-Client-Secret": conf.clientSecret }), ...(body && { "content-type": "application/json" }) },
		...(body && { body: JSON.stringify(body) }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) die(`schedule: ${data.error ?? res.status}`);
	return data;
}

const show = (s) => {
	const when = s.when.cron ? `cron "${s.when.cron}" (${s.when.tz})` : `once at ${new Date(s.when.at).toISOString()}`;
	const next = s.nextRun ? ` next: ${new Date(s.nextRun).toISOString()}` : "";
	return `${s.id}  [${s.status}]  ${s.name}  ${when}${next}`;
};

(async () => {
	if (cmd === "list") {
		const { schedules } = await call("GET", "");
		console.log(schedules.length ? schedules.map(show).join("\n") : "no schedules");
	} else if (cmd === "add") {
		const { body } = parse(rest);
		const { schedule } = await call("POST", "", body);
		console.log(`${show(schedule)}\nProposed: the owner must confirm it in Telegram (✅ Активувати) before it runs. Tell the owner.`);
	} else if (cmd === "edit") {
		const { body, positional } = parse(rest);
		if (!positional[0] || !Object.keys(body).length) die(USAGE, 2);
		const { schedule } = await call("PATCH", `/${positional[0]}`, body);
		console.log(`${show(schedule)}\nThe change must be confirmed by the owner in Telegram (✅ Активувати) before it takes effect. Tell the owner.`);
	} else if (cmd === "delete") {
		if (!rest[0]) die(USAGE, 2);
		await call("DELETE", `/${rest[0]}`);
		console.log("deleted");
	} else die(USAGE, 2);
})().catch((e) => die(`schedule: ${e.message}`));
