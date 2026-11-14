import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Page, KpiGrid, ChartGrid } from "./components/Page";
import { Kpi } from "./components/Kpi";
import { ChartCard, ChartTooltip, axisProps, gridProps, series } from "./components/ChartCard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Table, TableCell, TableHead, TableRow } from "./components/ui/table";
import { Badge } from "./components/ui/badge";
import { AgentFlow, AgentModules, Cicd, NotesLayers, NotesPipeline, Overview, SitesFlow } from "./diagrams";
import { how } from "./content";
import { formatNumber } from "./lib/utils";
import data from "./generated.json";

const blob = (path: string) => `${data.repoUrl}/blob/main/${path}`;

export default function App() {
  const apps = data.apps.filter((a) => a.kind === "app");
  const packages = data.apps.filter((a) => a.kind === "package");
  const count = (a: (typeof data.apps)[number]) => a.modules.reduce((s, m) => s + m.files.length, 0);
  const sizes = data.apps.map((a) => ({ name: a.name.split("/")[1], files: count(a) }));
  return (
    <Page title="Архітектура бота й агента" subtitle={`Знімок main · коміт ${data.sha.slice(0, 7)} · ${data.date}`}>
      <KpiGrid>
        <Kpi label="Воркерів" value={formatNumber(apps.length)} />
        <Kpi label="Спільних пакетів" value={formatNumber(packages.length)} />
        <Kpi label="Файлів у src" value={formatNumber(sizes.reduce((s, x) => s + x.files, 0))} />
        <Kpi label="Архітектурних рішень (ADR)" value={formatNumber(data.adrs.length)} />
      </KpiGrid>

      <ChartGrid>
        {how.map((h) => (
          <Card key={h.title}>
            <CardHeader>
              <CardTitle>{h.title}</CardTitle>
              <CardDescription>{h.subtitle}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {h.points.map((p) => <p key={p}>{p}</p>)}
            </CardContent>
          </Card>
        ))}
      </ChartGrid>

      <ChartGrid>
        <Overview />
        <NotesPipeline />
        <NotesLayers />
        <AgentFlow />
        <AgentModules />
        <SitesFlow />
        <Cicd />
      </ChartGrid>

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

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Архітектурні рішення</h2>
        <ChartGrid>
          {data.adrs.map((a) => (
            <Card key={a.file}>
              <CardHeader>
                <CardTitle><a className="underline-offset-4 hover:underline" href={blob(a.file)}>{a.title}</a></CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">{a.decision}</CardContent>
            </Card>
          ))}
        </ChartGrid>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Модулі й прив'язки</h2>
        <p className="text-sm text-muted-foreground">Генерується з репозиторію при кожній збірці: теки src і прив'язки Cloudflare з wrangler.toml.</p>
        <ChartGrid>
          {data.apps.map((a) => (
            <Card key={a.name} className={a.modules.length > 12 ? "lg:col-span-2" : undefined}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{a.name}</CardTitle>
                  <Badge>{a.kind === "app" ? "воркер" : "пакет"} · {count(a)} файлів</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Table>
                  <thead><tr><TableHead>Модуль</TableHead><TableHead>Файли</TableHead></tr></thead>
                  <tbody>
                    {a.modules.map((m) => (
                      <TableRow key={m.dir}>
                        <TableCell className="whitespace-nowrap font-medium">{m.dir || "src"}</TableCell>
                        <TableCell className="text-muted-foreground">{m.files.join(", ")}</TableCell>
                      </TableRow>
                    ))}
                  </tbody>
                </Table>
                {a.bindings && <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{a.bindings}</pre>}
              </CardContent>
            </Card>
          ))}
        </ChartGrid>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Документація в репозиторії</CardTitle>
          <CardDescription>Повні описи на GitHub (гілка main)</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {data.docs.map((d) => (
              <li key={d.path}><a className="underline-offset-4 hover:underline" href={blob(d.path)}>{d.title}</a> <span className="text-muted-foreground">{d.path}</span></li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </Page>
  );
}
