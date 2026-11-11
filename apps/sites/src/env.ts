// Прив'язки й секрети воркера сайтів (див. wrangler.toml і README).
export interface Env {
	SITES: R2Bucket;
	// Cloudflare Access: team domain (`<team>.cloudflareaccess.com`) і AUD застосунку для sites.example.com
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
	PUBLIC?: string; // "1" лише в wrangler-середовищі public: відкритий хост без Access, без списку сайтів, із CSP і noindex
	LOCAL_DEV?: string; // лише `wrangler dev`: вимикає перевірку Access
}
