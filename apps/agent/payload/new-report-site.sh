#!/bin/sh
# Створює стартовий проєкт звіту (Vite + React + Tailwind 4 + shadcn-стиль + Recharts) і ставить залежності:
#   new-report-site <тека>
# Далі: правиш src/data.ts і src/App.tsx, `npm run build`, `publish dist <назва>`. Правила: скіл report-site.
set -eu
dir=${1:?"використання: new-report-site <тека>"}
if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
	echo "тека $dir не порожня" >&2
	exit 1
fi
mkdir -p "$dir/src/components/ui" "$dir/src/lib"
cd "$dir"

cat > package.json <<'REPORT_SITE_EOF'
{
  "name": "report-site",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "dependencies": {
    "clsx": "^2.1.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "recharts": "^3.0.0",
    "tailwind-merge": "^3.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^7.0.0"
  }
}
REPORT_SITE_EOF

cat > vite.config.ts <<'REPORT_SITE_EOF'
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// base "./": сайт живе під /<назва>/, тому всі шляхи відносні
export default defineConfig({ base: "./", plugins: [react(), tailwindcss()] });
REPORT_SITE_EOF

cat > tsconfig.json <<'REPORT_SITE_EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "vite.config.ts"]
}
REPORT_SITE_EOF

cat > index.html <<'REPORT_SITE_EOF'
<!doctype html>
<html lang="uk">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Звіт</title>
    <script>
      // Тема до першого малювання, щоб не мигало: збережений вибір, інакше системна
      const t = localStorage.getItem("theme");
      if (t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
REPORT_SITE_EOF

cat > src/index.css <<'REPORT_SITE_EOF'
@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

/* Токени shadcn/ui (нейтральна палітра). Кольори не вигадуй заново: бери з токенів. */
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --positive: oklch(0.55 0.15 150);
  --negative: oklch(0.577 0.245 27);
  --chart-1: oklch(0.623 0.214 259.8);
  --chart-2: oklch(0.696 0.17 162);
  --chart-3: oklch(0.769 0.188 70);
  --chart-4: oklch(0.606 0.25 292);
  --chart-5: oklch(0.645 0.246 16);
  --radius: 0.625rem;
}
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --border: oklch(1 0 0 / 10%);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --positive: oklch(0.72 0.17 150);
  --negative: oklch(0.704 0.191 22);
  --chart-1: oklch(0.707 0.165 254);
  --chart-2: oklch(0.765 0.15 162);
  --chart-3: oklch(0.828 0.16 80);
  --chart-4: oklch(0.714 0.19 293);
  --chart-5: oklch(0.712 0.19 14);
}
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-positive: var(--positive);
  --color-negative: var(--negative);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
}
@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground antialiased; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
}
REPORT_SITE_EOF

cat > src/data.ts <<'REPORT_SITE_EOF'
// Єдине місце з даними звіту. Замін приклад справжніми даними (вбудуй їх сюди або імпортуй JSON поруч).
export const period = "січень – червень 2026";

export const monthly = [
  { month: "2026-01-01", spent: 12400, income: 30000 },
  { month: "2026-02-01", spent: 11800, income: 30000 },
  { month: "2026-03-01", spent: 14250, income: 32000 },
  { month: "2026-04-01", spent: 13100, income: 30000 },
  { month: "2026-05-01", spent: 15600, income: 34000 },
  { month: "2026-06-01", spent: 12900, income: 30000 },
];

export const categories = [
  { name: "Продукти", value: 38000 },
  { name: "Транспорт", value: 12500 },
  { name: "Дім", value: 9800 },
  { name: "Розваги", value: 7400 },
  { name: "Інше", value: 11350 },
];

export const rows = [
  { date: "2026-06-28", name: "Сільпо", category: "Продукти", amount: 1240.5 },
  { date: "2026-06-25", name: "Uklon", category: "Транспорт", amount: 215 },
  { date: "2026-06-22", name: "Сільпо", category: "Продукти", amount: 876.3 },
];
REPORT_SITE_EOF

cat > src/App.tsx <<'REPORT_SITE_EOF'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { Page, KpiGrid, ChartGrid } from "./components/Page";
import { Kpi } from "./components/Kpi";
import { ChartCard, ChartTooltip, axisProps, gridProps, series } from "./components/ChartCard";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Table, TableCell, TableHead, TableRow } from "./components/ui/table";
import { Badge } from "./components/ui/badge";
import { categories, monthly, period, rows } from "./data";
import { formatDate, formatMoney, formatMonth, formatNumber } from "./lib/utils";

// Приклад звіту: KPI → графіки → таблиця. Лиши структуру, заміни зміст.
export default function App() {
  const total = monthly.reduce((s, m) => s + m.spent, 0);
  return (
    <Page title="Витрати" subtitle={period}>
      <KpiGrid>
        <Kpi label="Усього витрачено" value={formatMoney(total)} />
        <Kpi label="У середньому за місяць" value={formatMoney(total / monthly.length)} />
        <Kpi label="Покупок" value={formatNumber(rows.length)} />
        <Kpi label="До попереднього місяця" value="−17%" delta="менше витрат" />
      </KpiGrid>

      <ChartGrid>
        <ChartCard title="Витрати по місяцях" description="Сума за місяць, ₴">
          <BarChart data={monthly}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" tickFormatter={formatMonth} {...axisProps} />
            <YAxis tickFormatter={formatNumber} width={56} {...axisProps} />
            <ChartTooltip formatter={formatMoney} />
            <Bar dataKey="spent" name="Витрати" fill={series(0)} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard title="Динаміка" description="Витрати й доходи">
          <LineChart data={monthly}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="month" tickFormatter={formatMonth} {...axisProps} />
            <YAxis tickFormatter={formatNumber} width={56} {...axisProps} />
            <ChartTooltip formatter={formatMoney} />
            <Line dataKey="income" name="Доходи" stroke={series(1)} strokeWidth={2} dot={false} />
            <Line dataKey="spent" name="Витрати" stroke={series(0)} strokeWidth={2} dot={false} />
          </LineChart>
        </ChartCard>
        <ChartCard title="За категоріями" description="Частка від усіх витрат">
          <PieChart>
            <Pie data={categories} dataKey="value" nameKey="name" innerRadius={60} outerRadius={100} stroke="var(--card)">
              {categories.map((_, i) => <Cell key={i} fill={series(i)} />)}
            </Pie>
            <ChartTooltip formatter={formatMoney} />
          </PieChart>
        </ChartCard>
        <Card>
          <CardHeader><CardTitle>Останні покупки</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <thead><tr><TableHead>Дата</TableHead><TableHead>Магазин</TableHead><TableHead>Категорія</TableHead><TableHead className="text-right">Сума</TableHead></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{formatDate(r.date)}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell><Badge>{r.category}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(r.amount, true)}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      </ChartGrid>
    </Page>
  );
}
REPORT_SITE_EOF

cat > src/main.tsx <<'REPORT_SITE_EOF'
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
REPORT_SITE_EOF

cat > src/lib/utils.ts <<'REPORT_SITE_EOF'
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
REPORT_SITE_EOF

cat > src/components/ChartCard.tsx <<'REPORT_SITE_EOF'
import type { ReactNode } from "react";
import { ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

// Спільні пропси осей і сітки Recharts, щоб усі графіки виглядали однаково
export const axisProps = { stroke: "var(--muted-foreground)", fontSize: 12, tickLine: false, axisLine: false } as const;
export const gridProps = { stroke: "var(--border)", vertical: false } as const;
export const series = (i: number) => `var(--chart-${(i % 5) + 1})`;

export const ChartTooltip = (props: { formatter?: (v: number) => string }) => (
  <Tooltip
    cursor={{ fill: "var(--muted)", opacity: 0.5 }}
    contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
    labelStyle={{ color: "var(--foreground)" }}
    itemStyle={{ color: "var(--foreground)" }}
    formatter={props.formatter ? (v) => props.formatter!(Number(v)) : undefined}
  />
);

// Картка з графіком: заголовок, опис і ResponsiveContainer фіксованої висоти. Усередину кладеш діаграму Recharts.
export function ChartCard({ title, description, height = 280, children }: { title: string; description?: string; height?: number; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {children as React.ReactElement}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
REPORT_SITE_EOF

cat > src/components/Diagram.tsx <<'REPORT_SITE_EOF'
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { series } from "./ChartCard";

// Схеми зібрані з SVG і кольорів-токенів, як і графіки: жодних hex

const MIN = 0.3;
const MAX = 8;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

function Svg({ title, viewBox, children, className }: { title: string; viewBox: string; children: ReactNode; className?: string }) {
  return (
    <svg viewBox={viewBox} className={className} role="img" aria-label={title} fontFamily="inherit">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--muted-foreground)" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

// Повноекранний перегляд: колесо й щипок масштабують, перетягування рухає, Esc закриває
function Viewer({ title, viewBox, children, onClose }: { title: string; viewBox: string; children: ReactNode; onClose: () => void }) {
  const area = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;

  // Масштаб навколо точки (px, py) відносно області перегляду
  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const s = clamp(v.s * factor);
      const k = s / v.s;
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  const center = () => {
    const r = area.current!.getBoundingClientRect();
    return [r.width / 2, r.height / 2] as const;
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // wheel має бути не пасивним, щоб скасувати прокрутку сторінки
    const el = area.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", key);
      el.removeEventListener("wheel", wheel);
      document.body.style.overflow = prev;
    };
  }, []);

  const down = (e: React.PointerEvent) => {
    area.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinch.current = 0;
  };
  const move = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const prev = { ...p };
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.current.size === 1) {
      setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current) {
        const r = area.current!.getBoundingClientRect();
        zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, dist / pinch.current);
      }
      pinch.current = dist;
    }
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pinch.current = 0;
  };

  const btn = "h-9 min-w-9 rounded-md border bg-card px-3 text-sm hover:bg-muted";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" role="dialog" aria-label={title}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          <button className={btn} onClick={() => zoomAt(...center(), 1 / 1.3)} aria-label="Зменшити">−</button>
          <span className="w-12 text-center text-sm tabular-nums text-muted-foreground">{Math.round(view.s * 100)}%</span>
          <button className={btn} onClick={() => zoomAt(...center(), 1.3)} aria-label="Збільшити">+</button>
          <button className={btn} onClick={() => setView({ x: 0, y: 0, s: 1 })}>Скинути</button>
          <button className={btn} onClick={onClose}>Закрити</button>
        </div>
      </div>
      <div
        ref={area}
        className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        style={{ touchAction: "none" }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={(e) => {
          const r = area.current!.getBoundingClientRect();
          zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8);
        }}
      >
        <div className="flex h-full w-full items-center justify-center p-4" style={{ transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
          <Svg title={title} viewBox={viewBox} className="max-h-full w-full select-none">{children}</Svg>
        </div>
      </div>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">Колесо чи щипок — масштаб, перетягування — рух, подвійний клік — наблизити, Esc — закрити</p>
    </div>
  );
}

export function DiagramCard({ title, description, viewBox, children, className }: { title: string; description?: string; viewBox: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          <button className="shrink-0 rounded-md border bg-card px-3 py-1.5 text-xs hover:bg-muted" onClick={() => setOpen(true)}>⤢ На весь екран</button>
        </div>
      </CardHeader>
      <CardContent>
        <Svg title={title} viewBox={viewBox} className="h-auto w-full">{children}</Svg>
      </CardContent>
      {open && <Viewer title={title} viewBox={viewBox} onClose={() => setOpen(false)}>{children}</Viewer>}
    </Card>
  );
}

type BoxProps = { x: number; y: number; w: number; h: number; title: string; lines?: string[]; color?: number; dashed?: boolean };

// Блок: кольорова смужка зліва, заголовок і короткі рядки
export function Box({ x, y, w, h, title, lines = [], color = 0, dashed }: BoxProps) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill="var(--card)" stroke="var(--border)" strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} />
      <rect x={x} y={y} width={5} height={h} rx={2} fill={series(color)} />
      <text x={x + 16} y={y + 24} fill="var(--foreground)" fontSize={14} fontWeight={600}>{title}</text>
      {lines.map((l, i) => (
        <text key={i} x={x + 16} y={y + 46 + i * 18} fill="var(--muted-foreground)" fontSize={12}>{l}</text>
      ))}
    </g>
  );
}

// Стрілка (ламана); label стоїть біля середини першого сегмента
export function Arrow({ points, label, labelAt, dashed, both }: { points: [number, number][]; label?: string; labelAt?: [number, number]; dashed?: boolean; both?: boolean }) {
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  const [lx, ly] = labelAt ?? [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2 - 6];
  return (
    <g>
      <path d={d} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray={dashed ? "5 4" : undefined} markerEnd="url(#arrow)" markerStart={both ? "url(#arrow)" : undefined} />
      {label && <text x={lx} y={ly} textAnchor="middle" fill="var(--muted-foreground)" fontSize={11}>{label}</text>}
    </g>
  );
}
REPORT_SITE_EOF

cat > src/components/Kpi.tsx <<'REPORT_SITE_EOF'
import { Card, CardContent, CardDescription } from "./ui/card";
import { cn } from "../lib/utils";

// Показник: велике число, підпис і (необов'язково) зміна. good=false фарбує зміну як погану (напр., витрати зросли).
export function Kpi({ label, value, delta, good = true }: { label: string; value: string; delta?: string; good?: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <CardDescription>{label}</CardDescription>
        <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
        {delta && <div className={cn("text-xs font-medium", good ? "text-positive" : "text-negative")}>{delta}</div>}
      </CardContent>
    </Card>
  );
}
REPORT_SITE_EOF

cat > src/components/Page.tsx <<'REPORT_SITE_EOF'
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
REPORT_SITE_EOF

cat > src/components/ThemeToggle.tsx <<'REPORT_SITE_EOF'
import { useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setDark(next);
  };
  return (
    <button onClick={toggle} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" aria-label="Змінити тему">
      {dark ? "☀️ Світла" : "🌙 Темна"}
    </button>
  );
}
REPORT_SITE_EOF

cat > src/components/ui/badge.tsx <<'REPORT_SITE_EOF'
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Badge = ({ className, ...p }: ComponentProps<"span">) => (
  <span className={cn("inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium", className)} {...p} />
);
REPORT_SITE_EOF

cat > src/components/ui/card.tsx <<'REPORT_SITE_EOF'
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Card = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("rounded-lg border bg-card text-foreground shadow-xs", className)} {...p} />
);
export const CardHeader = ({ className, ...p }: ComponentProps<"div">) => <div className={cn("flex flex-col gap-1 p-5 pb-0", className)} {...p} />;
export const CardTitle = ({ className, ...p }: ComponentProps<"h3">) => <h3 className={cn("text-sm font-medium", className)} {...p} />;
export const CardDescription = ({ className, ...p }: ComponentProps<"p">) => <p className={cn("text-sm text-muted-foreground", className)} {...p} />;
export const CardContent = ({ className, ...p }: ComponentProps<"div">) => <div className={cn("p-5", className)} {...p} />;
REPORT_SITE_EOF

cat > src/components/ui/table.tsx <<'REPORT_SITE_EOF'
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Table = ({ className, ...p }: ComponentProps<"table">) => (
  <div className="w-full overflow-x-auto">
    <table className={cn("w-full text-sm", className)} {...p} />
  </div>
);
export const TableHead = ({ className, ...p }: ComponentProps<"th">) => (
  <th className={cn("h-10 border-b px-3 text-left align-middle font-medium text-muted-foreground", className)} {...p} />
);
export const TableRow = ({ className, ...p }: ComponentProps<"tr">) => <tr className={cn("border-b last:border-0 hover:bg-muted/50", className)} {...p} />;
export const TableCell = ({ className, ...p }: ComponentProps<"td">) => <td className={cn("px-3 py-2.5 align-middle", className)} {...p} />;
REPORT_SITE_EOF

printf 'node_modules\ndist\n' > .gitignore
npm install --no-audit --no-fund --loglevel=error
echo "Готово: $(pwd). Далі правиш src/data.ts і src/App.tsx, потім npm run build."
