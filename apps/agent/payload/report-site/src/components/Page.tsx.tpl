import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

// Каркас сторінки: заголовок, підзаголовок (період/джерело), перемикач теми, вміст
export function Page({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <ThemeToggle />
      </header>
      {children}
    </main>
  );
}

// Сітка секцій: KPI зверху (grid-kpi), графіки по два в ряд (grid-charts)
export const KpiGrid = ({ children }: { children: ReactNode }) => <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">{children}</section>;
export const ChartGrid = ({ children }: { children: ReactNode }) => <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">{children}</section>;
