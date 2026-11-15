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
