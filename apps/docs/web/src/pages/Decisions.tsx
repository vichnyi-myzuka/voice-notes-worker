import { ChartGrid } from "../components/Page";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableCell, TableHead, TableRow } from "../components/ui/table";
import { Badge } from "../components/ui/badge";
import { blob, countFiles, data } from "../data";

export default function Decisions() {
  return (
    <>
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
                  <Badge>{a.kind === "app" ? "воркер" : "пакет"} · {countFiles(a)} файлів</Badge>
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
    </>
  );
}
