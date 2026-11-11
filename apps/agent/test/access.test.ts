import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessCache, verifyAccess } from "../src/infrastructure/access";

const TEAM = "team.cloudflareaccess.com";
const AUD = "app-aud";
const enc = new TextEncoder();
const b64url = (data: ArrayBuffer | string) => {
	const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

beforeAll(async () => {
	keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
});

beforeEach(() => {
	resetAccessCache();
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
});
afterEach(() => vi.unstubAllGlobals());

async function token(claims: object, signer: CryptoKey = keys.privateKey, header: object = { alg: "RS256", kid: "k1" }) {
	const signing = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, enc.encode(signing));
	return `${signing}.${b64url(sig)}`;
}
const req = (jwt?: string) => new Request("https://agent.example/", { headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
const good = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600 });
const cfg = { teamDomain: TEAM, aud: AUD };

describe("verifyAccess", () => {
	it("приймає справжній токен для свого застосунку", async () => {
		expect(await verifyAccess(req(await token(good())), cfg)).toBe(true);
	});

	it("відхиляє запит без токена або без налаштувань", async () => {
		expect(await verifyAccess(req(), cfg)).toBe(false);
		expect(await verifyAccess(req(await token(good())), {})).toBe(false);
	});

	it("відхиляє чужий aud, чужого видавця й прострочений токен", async () => {
		expect(await verifyAccess(req(await token({ ...good(), aud: ["other"] })), cfg)).toBe(false);
		expect(await verifyAccess(req(await token({ ...good(), iss: "https://evil.example" })), cfg)).toBe(false);
		expect(await verifyAccess(req(await token({ ...good(), exp: Math.floor(Date.now() / 1000) - 10 })), cfg)).toBe(false);
	});

	it("відхиляє токен, підписаний іншим ключем, і невідомий kid", async () => {
		const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		expect(await verifyAccess(req(await token(good(), other.privateKey)), cfg)).toBe(false);
		expect(await verifyAccess(req(await token(good(), keys.privateKey, { alg: "RS256", kid: "nope" })), cfg)).toBe(false);
	});

	it("відхиляє алгоритм, що не RS256, і сміття замість токена", async () => {
		expect(await verifyAccess(req(await token(good(), keys.privateKey, { alg: "none", kid: "k1" })), cfg)).toBe(false);
		expect(await verifyAccess(req("not-a-jwt"), cfg)).toBe(false);
	});
});
