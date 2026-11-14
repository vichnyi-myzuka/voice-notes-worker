import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

// Формати для всіх звітів: українська локаль, гривня
const nf = new Intl.NumberFormat("uk-UA");
export const formatNumber = (n: number) => nf.format(n);
const money = new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH", maximumFractionDigits: 0 });
const moneyExact = new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH" });
export const formatMoney = (n: number, exact = false) => (exact ? moneyExact : money).format(n);
export const formatPercent = (n: number) => new Intl.NumberFormat("uk-UA", { style: "percent", maximumFractionDigits: 1 }).format(n);
export const formatDate = (d: string | Date) => new Date(d).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
export const formatMonth = (d: string | Date) => new Date(d).toLocaleDateString("uk-UA", { month: "short", year: "2-digit" });
