// Веб-сторінка автоматизацій (ADR 0005): одна статична сторінка, що працює над /api/schedules (за тим самим Access, що й решта воркера).
// Таблиця з діями, форма створення й редагування (з переглядом найближчих запусків) та історія з посиланнями на сесії.
// У скрипті немає шаблонних рядків і innerHTML з даними: усе будується через DOM (textContent), щоб prompt чи назва не виконувались як код.
export const AUTOMATIONS_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Автоматизації агента</title>
<style>
:root { color-scheme: light dark; --bd: #8884; --muted: #888; --accent: #2a7ae2; --bad: #d33; }
body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; padding: 1rem; max-width: 960px; }
h1 { font-size: 1.3rem; margin: .2rem 0 1rem; }
button, input, select, textarea { font: inherit; padding: .35rem .6rem; border: 1px solid var(--bd); border-radius: 6px; background: transparent; color: inherit; }
button { cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { color: var(--bad); }
button:disabled { opacity: .5; cursor: default; }
.card { border: 1px solid var(--bd); border-radius: 10px; padding: .8rem 1rem; margin: .7rem 0; }
.row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.row > .grow { flex: 1 1 14rem; min-width: 0; }
.muted { color: var(--muted); font-size: .88rem; }
.badge { font-size: .78rem; padding: .05rem .5rem; border: 1px solid var(--bd); border-radius: 999px; }
.prompt { white-space: pre-wrap; margin: .4rem 0; max-height: 7rem; overflow: auto; }
label { display: block; margin: .6rem 0 .2rem; font-size: .88rem; color: var(--muted); }
form input, form textarea, form select { width: 100%; box-sizing: border-box; }
form textarea { min-height: 7rem; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0 1rem; }
#error { color: var(--bad); min-height: 1.2rem; margin-top: .5rem; }
#times div { font-variant-numeric: tabular-nums; }
.runs div { padding: .15rem 0; }
a { color: var(--accent); }
</style>
</head>
<body>
<div class="row"><h1 class="grow">⏰ Автоматизації агента</h1><button id="new" class="primary">＋ Нова</button></div>
<div id="list"></div>

<div id="editor" class="card" hidden>
<form id="form">
<div class="row"><strong id="formTitle" class="grow"></strong><button type="button" id="cancel">✕</button></div>
<label for="name">Назва</label><input id="name" required maxlength="80">
<label for="prompt">Prompt (сесія стартує без пам'яті про розмову: пиши самодостатньо)</label><textarea id="prompt" required></textarea>
<div class="cols">
<div><label for="mode">Коли</label><select id="mode"><option value="cron">Повторно (cron)</option><option value="at">Один раз</option></select></div>
<div id="cronBox"><label for="cron">Cron: хвилина година день місяць день-тижня</label><input id="cron" placeholder="0 9 * * 1-5"></div>
<div id="atBox"><label for="at">Дата й час (за часом браузера)</label><input id="at" type="datetime-local"></div>
<div id="tzBox"><label for="tz">Часовий пояс</label><input id="tz" value="Europe/Kyiv"></div>
</div>
<div class="cols">
<div><label for="repo">Репозиторій (owner/name, необов'язково)</label><input id="repo" placeholder="owner/name"></div>
<div><label for="model">Модель (необов'язково)</label><input id="model" placeholder="opus"></div>
<div><label for="expires">Діє до (необов'язково)</label><input id="expires" type="datetime-local"></div>
</div>
<label>Найближчі запуски</label><div id="times" class="muted">—</div>
<div id="error"></div>
<div class="row"><button class="primary" id="save" type="submit">Зберегти</button></div>
</form>
</div>

<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var schedules = [];
var editing = null; // розклад, що редагується; null — створення
var loadedTiming = ""; // «at|cron|tz» у момент відкриття форми: без зміни часу його не надсилаємо

var STATUS = { pending: "⏳ чекає підтвердження", active: "🟢 активна", paused: "⏸ на паузі", done: "✔️ завершена" };
var RESULT = { ok: "✅ запущено", failed: "❌ не вдалося", skipped: "⏭ пропущено" };

function el(tag, attrs, children) {
	var node = document.createElement(tag);
	Object.keys(attrs || {}).forEach(function (k) {
		if (k === "text") node.textContent = attrs[k];
		else if (k === "class") node.className = attrs[k];
		else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), attrs[k]);
		else node.setAttribute(k, attrs[k]);
	});
	(children || []).forEach(function (c) { if (c) node.appendChild(c); });
	return node;
}
function fmt(ms, tz) { return new Date(ms).toLocaleString("uk-UA", { timeZone: tz || "Europe/Kyiv", dateStyle: "short", timeStyle: "short" }); }
function tzOf(s) { return s.when.cron ? s.when.tz : "Europe/Kyiv"; }

async function api(method, path, body) {
	var res = await fetch("/api/schedules" + path, { method: method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
	var data = await res.json().catch(function () { return {}; });
	if (!res.ok) throw new Error(data.error || String(res.status));
	return data;
}

async function load() {
	try { schedules = (await api("GET", "")).schedules; render(); }
	catch (e) { $("list").replaceChildren(el("div", { class: "card", text: "Не вдалося завантажити: " + e.message })); }
}

function act(label, fn, cls) {
	var b = el("button", { text: label, class: cls || "" });
	b.addEventListener("click", async function () {
		b.disabled = true;
		try { await fn(); } catch (e) { alert(e.message); }
		await load();
	});
	return b;
}

function card(s) {
	var tz = tzOf(s);
	var last = s.runs.length ? s.runs[s.runs.length - 1] : null;
	var when = s.when.cron ? "cron " + s.when.cron + " (" + s.when.tz + ")" : "один раз, " + fmt(s.when.at, tz);
	var info = [when];
	if (s.nextRun && s.status !== "paused") info.push((s.status === "pending" ? "перший" : "наступний") + " запуск: " + fmt(s.nextRun, tz));
	if (last) info.push("останній: " + fmt(last.at, tz) + ", " + RESULT[last.result]);
	if (s.repo) info.push("📦 " + s.repo);
	if (s.model) info.push("🤖 " + s.model);
	if (s.expiresAt) info.push("діє до " + fmt(s.expiresAt, tz));
	if (s.createdBy === "agent") info.push("створив агент");
	var runs = el("div", { class: "runs muted", hidden: "" });
	var buttons = [];
	if (s.status === "pending") buttons.push(act("✅ Активувати", function () { return api("POST", "/" + s.id + "/resume"); }, "primary"));
	if (s.status === "active") buttons.push(act("⏸ Пауза", function () { return api("POST", "/" + s.id + "/pause"); }));
	if (s.status === "paused") buttons.push(act("▶️ Увімкнути", function () { return api("POST", "/" + s.id + "/resume"); }));
	if (s.status !== "pending") buttons.push(act("▶️ Запустити зараз", function () { return api("POST", "/" + s.id + "/run"); }));
	buttons.push(el("button", { text: "✏️ Змінити", onclick: function () { openForm(s); } }));
	buttons.push(el("button", { text: "📜 Історія", onclick: function () { showRuns(s, runs); } }));
	buttons.push(act(s.status === "pending" ? "❌ Відхилити" : "🗑 Видалити", function () {
		if (!confirm("Видалити «" + s.name + "»?")) return Promise.resolve();
		return api("DELETE", "/" + s.id);
	}, "danger"));
	return el("div", { class: "card" }, [
		el("div", { class: "row" }, [el("strong", { class: "grow", text: s.name }), el("span", { class: "badge", text: STATUS[s.status] })]),
		el("div", { class: "muted", text: info.join(" · ") }),
		el("div", { class: "prompt", text: s.prompt }),
		el("div", { class: "row" }, buttons),
		runs
	]);
}

function showRuns(s, box) {
	if (!box.hidden) { box.hidden = true; return; }
	box.replaceChildren();
	if (!s.runs.length) box.appendChild(el("div", { text: "Запусків ще не було." }));
	s.runs.slice(-20).reverse().forEach(function (r) {
		var line = el("div", { text: fmt(r.at, tzOf(s)) + " · " + RESULT[r.result] + (r.error ? " · " + r.error : "") });
		if (r.sessionId) { line.appendChild(document.createTextNode(" · ")); line.appendChild(el("a", { href: "/s/" + r.sessionId, text: "сесія" })); }
		box.appendChild(line);
	});
	box.hidden = false;
}

function render() {
	$("list").replaceChildren.apply($("list"), schedules.length ? schedules.map(card) : [el("div", { class: "muted", text: "Автоматизацій ще немає. Створи тут або попроси агента в Telegram." })]);
}

// datetime-local ↔ мс (час браузера)
function toLocalInput(ms) { var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
function modeChanged() {
	var once = $("mode").value === "at";
	$("atBox").hidden = !once; $("cronBox").hidden = once; $("tzBox").hidden = once;
	previewTimes();
}
function timingBody() {
	if ($("mode").value === "at") return $("at").value ? { at: new Date($("at").value).toISOString() } : {};
	return { cron: $("cron").value.trim(), tz: $("tz").value.trim() || undefined };
}
function timingKey() { var t = timingBody(); return [t.at || "", t.cron || "", t.tz || ""].join("|"); }

function openForm(s) {
	editing = s;
	$("formTitle").textContent = s ? "Змінити «" + s.name + "»" : "Нова автоматизація";
	$("name").value = s ? s.name : "";
	$("prompt").value = s ? s.prompt : "";
	$("repo").value = s && s.repo || "";
	$("model").value = s && s.model || "";
	$("expires").value = s && s.expiresAt ? toLocalInput(s.expiresAt) : "";
	$("mode").value = s && s.when.at ? "at" : "cron";
	$("cron").value = s && s.when.cron || "";
	$("tz").value = s && s.when.tz || "Europe/Kyiv";
	$("at").value = s && s.when.at ? toLocalInput(s.when.at) : "";
	$("error").textContent = "";
	$("editor").hidden = false;
	modeChanged();
	loadedTiming = timingKey();
	$("editor").scrollIntoView({ behavior: "smooth" });
}

var timer;
function previewTimes() {
	clearTimeout(timer);
	timer = setTimeout(async function () {
		var box = $("times");
		var t = timingBody();
		if (!t.at && !t.cron) { box.textContent = "—"; return; }
		try {
			var times = (await api("POST", "/preview", t)).times;
			box.replaceChildren.apply(box, times.map(function (ms) { return el("div", { text: fmt(ms, t.tz) }); }));
			$("error").textContent = "";
		} catch (e) { box.textContent = "—"; $("error").textContent = e.message; }
	}, 350);
}

$("new").addEventListener("click", function () { openForm(null); });
$("cancel").addEventListener("click", function () { $("editor").hidden = true; });
$("mode").addEventListener("change", modeChanged);
["cron", "tz", "at"].forEach(function (id) { $(id).addEventListener("input", previewTimes); });

$("form").addEventListener("submit", async function (ev) {
	ev.preventDefault();
	$("error").textContent = "";
	var body = { name: $("name").value.trim(), prompt: $("prompt").value.trim(), repo: $("repo").value.trim(), model: $("model").value.trim() };
	body.expiresAt = $("expires").value ? new Date($("expires").value).toISOString() : ""; // порожнє знімає термін дії
	// Зміна без чіпання часу не надсилає його: інакше минулий одноразовий розклад не вдалося б навіть перейменувати.
	if (!editing || timingKey() !== loadedTiming) Object.assign(body, timingBody());
	$("save").disabled = true;
	try {
		if (editing) await api("PATCH", "/" + editing.id, body);
		else await api("POST", "", body);
		$("editor").hidden = true;
		await load();
	} catch (e) { $("error").textContent = e.message; }
	$("save").disabled = false;
});

load();
</script>
</body>
</html>
`;
