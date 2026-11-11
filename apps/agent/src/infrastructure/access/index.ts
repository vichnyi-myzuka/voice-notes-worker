// Перевірка JWT від Cloudflare Access (заголовок Cf-Access-Jwt-Assertion): другий рівень захисту поверх самого Access,
// щоб воркер не відповідав, якщо до workers.dev хтось звернувся повз Access.

export type AccessConfig = { teamDomain?: string; aud?: string };

type Jwk = JsonWebKey & { kid?: string };
type Certs = { keys: Jwk[] };

const CERTS_TTL_MS = 60 * 60 * 1000;
let cached: { domain: string; at: number; certs: Certs } | undefined;

const b64url = (s: string): Uint8Array<ArrayBuffer> => {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const json = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64url(s)));

async function certsFor(domain: string): Promise<Certs> {
	if (cached && cached.domain === domain && Date.now() - cached.at < CERTS_TTL_MS) return cached.certs;
	const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs: ${res.status}`);
	const certs = await res.json<Certs>();
	cached = { domain, at: Date.now(), certs };
	return certs;
}

export const resetAccessCache = () => void (cached = undefined);

// true — токен справжній, виданий для цього застосунку (aud) і не прострочений.
export async function verifyAccess(req: Request, cfg: AccessConfig): Promise<boolean> {
	if (!cfg.teamDomain || !cfg.aud) return false;
	const token = req.headers.get("cf-access-jwt-assertion");
	const parts = token?.split(".");
	if (parts?.length !== 3) return false;
	const [h, p, s] = parts;
	try {
		const header = json<{ alg?: string; kid?: string }>(h);
		if (header.alg !== "RS256") return false;
		const jwk = (await certsFor(cfg.teamDomain)).keys.find((k) => k.kid === header.kid);
		if (!jwk) return false;
		const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
		if (!ok) return false;
		const claims = json<{ aud?: string | string[]; exp?: number; iss?: string }>(p);
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		return aud.includes(cfg.aud) && claims.iss === `https://${cfg.teamDomain}` && typeof claims.exp === "number" && claims.exp * 1000 > Date.now();
	} catch (err) {
		console.error("access verify failed:", err);
		return false;
	}
}
