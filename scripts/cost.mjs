// Витрати Cloudflare по днях і продуктах (Billable Usage API, alpha). Запуск: npm run cost [-- <днів, типово 7>]
// Потрібні в .env: CLOUDFLARE_API_TOKEN (право Billing Read) і CLOUDFLARE_ACCOUNT_ID. Значень не друкуємо.
// Без параметрів API віддає поточний розрахунковий період (діапазон мусить містити його початок), тож днів може бути менше за запит.
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
	console.error("Додай у .env CLOUDFLARE_API_TOKEN (право Billing Read) і CLOUDFLARE_ACCOUNT_ID.");
	process.exit(1);
}
const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1) {
	console.error("Кількість днів — додатне ціле число.");
	process.exit(1);
}

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/billable-usage`, { headers: { authorization: `Bearer ${token}` } });
const body = await res.json().catch(() => null);
if (!res.ok || !body?.success) {
	console.error(`Помилка API (${res.status}): ${body?.errors?.map((e) => e.message).join("; ") ?? "невідома відповідь"}`);
	process.exit(1);
}

const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
const currency = body.result[0]?.BillingCurrency ?? "USD";
const byDay = new Map(); // день → продукт → вартість
for (const row of body.result) {
	const day = row.ChargePeriodStart.slice(0, 10);
	if (day < since) continue;
	const products = byDay.get(day) ?? new Map();
	products.set(row.ServiceName, (products.get(row.ServiceName) ?? 0) + row.ContractedCost);
	byDay.set(day, products);
}

const money = (n) => `${n.toFixed(4)} ${currency}`;
let total = 0;
for (const day of [...byDay.keys()].sort()) {
	const products = [...byDay.get(day)].filter(([, cost]) => cost > 0).sort((a, b) => b[1] - a[1]);
	const sum = products.reduce((s, [, cost]) => s + cost, 0);
	total += sum;
	console.log(`${day}  ${money(sum)}`);
	for (const [name, cost] of products) console.log(`    ${name}: ${money(cost)}`);
}
if (!byDay.size) console.log("Даних за цей період немає (дані оновлюються раз на день).");
else console.log(`\nРазом за ${byDay.size} дн.: ${money(total)}. Це лише плата понад безкоштовні ліміти; фіксовані підписки (Workers Paid) не входять.`);
