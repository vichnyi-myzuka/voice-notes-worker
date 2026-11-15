import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";
import { ChartGrid } from "./Page";
import { how } from "../content";
import { byPage, statusLabels, type FeatureCategory, type FeatureStatus } from "../features";
import type { Page } from "../content";

// Описи роботи з content.ts для сторінки
export function HowCards({ page }: { page: Page }) {
  return (
    <ChartGrid>
      {how.filter((h) => h.page === page).map((h) => (
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
  );
}

const statusStyle: Record<FeatureStatus, string> = {
  done: "",
  wip: "bg-primary text-primary-foreground",
  planned: "border border-dashed bg-transparent text-muted-foreground",
};

// Каталог фіч сторінки за категоріями з features.ts
export function Features({ page }: { page: FeatureCategory["page"] }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">Можливості</h2>
      <ChartGrid>
        {byPage(page).map((c) => (
          <Card key={c.id}>
            <CardHeader>
              <CardTitle>{c.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-3 text-sm">
                {c.features.map((f) => (
                  <li key={f.name} className="flex items-start justify-between gap-3">
                    <span><span className="font-medium">{f.name}.</span> <span className="text-muted-foreground">{f.text}</span></span>
                    <Badge className={statusStyle[f.status]}>{statusLabels[f.status]}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </ChartGrid>
    </section>
  );
}
