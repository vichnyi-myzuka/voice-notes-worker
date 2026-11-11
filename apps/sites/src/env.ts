// Прив'язки й секрети воркера сайтів (див. wrangler.toml і README).
export interface Env {
	SITES: R2Bucket;
	// Cloudflare Access: team domain (`<team>.cloudflareaccess.com`) і AUD застосунку для sites.valentyi.dev
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	LOCAL_DEV?: string; // лише `wrangler dev`: вимикає перевірку Access
}
