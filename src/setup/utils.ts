export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export const clean = (v: unknown) => String(v ?? "").replace(/^[@#]/, "").replace(/\s+/g, " ").trim();

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
