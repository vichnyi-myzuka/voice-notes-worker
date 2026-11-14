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
