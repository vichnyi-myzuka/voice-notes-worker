// Прив'язки й секрети воркера документації (див. wrangler.toml і README).
export interface Env {
	ASSETS: Fetcher;
	// Cloudflare Access: team domain (`<team>.cloudflareaccess.com`) і AUD застосунку для docs.example.com
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	LOCAL_DEV?: string; // лише `wrangler dev`: вимикає перевірку Access
}
