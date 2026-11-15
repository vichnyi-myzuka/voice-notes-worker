import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { KpiGrid, ChartGrid } from "../components/Page";
import { Kpi } from "../components/Kpi";
import { ChartCard, ChartTooltip, axisProps, gridProps, series } from "../components/ChartCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableCell, TableHead, TableRow } from "../components/ui/table";
import { HowCards } from "../components/Sections";
import { Cicd, Overview as OverviewDiagram } from "../diagrams";
import { countFiles, data } from "../data";
import { formatNumber } from "../lib/utils";

export default function Overview() {
  const apps = data.apps.filter((a) => a.kind === "app");
  const packages = data.apps.filter((a) => a.kind === "package");
  const sizes = data.apps.map((a) => ({ name: a.name.split("/")[1], files: countFiles(a) }));
  return (
    <>
      <KpiGrid>
        <Kpi label="Воркерів" value={formatNumber(apps.length)} />
        <Kpi label="Спільних пакетів" value={formatNumber(packages.length)} />
        <Kpi label="Файлів у src" value={formatNumber(sizes.reduce((s, x) => s + x.files, 0))} />
        <Kpi label="Архітектурних рішень (ADR)" value={formatNumber(data.adrs.length)} />
      </KpiGrid>
      <ChartGrid>
        <OverviewDiagram />
        <Cicd />
      </ChartGrid>
      <HowCards page="overview" />
      <ChartGrid>
        <ChartCard title="Розмір застосунків" description="Файлів у src, без тестів (з репозиторію)">
          <BarChart data={sizes} layout="vertical">
            <CartesianGrid {...gridProps} horizontal={false} vertical />
            <XAxis type="number" {...axisProps} />
            <YAxis type="category" dataKey="name" width={110} {...axisProps} />
            <ChartTooltip formatter={formatNumber} />
            <Bar dataKey="files" name="Файлів" fill={series(0)} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <Card>
          <CardHeader>
            <CardTitle>Останні мержі в main</CardTitle>
            <CardDescription>Що змінювалось у системі останнім часом</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <thead><tr><TableHead>Дата</TableHead><TableHead>Зміна</TableHead></tr></thead>
              <tbody>
                {data.merges.map((m, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap tabular-nums">{m.date}</TableCell>
                    <TableCell>{m.title}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      </ChartGrid>
    </>
  );
}
