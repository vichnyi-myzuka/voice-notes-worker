import { cn } from "../lib/utils";
import type { Page } from "../content";

export const pages: { id: Page; title: string }[] = [
  { id: "overview", title: "Огляд" },
  { id: "notes", title: "Нотатки" },
  { id: "agent", title: "Агент" },
  { id: "sites", title: "Сайти й MCP" },
  { id: "decisions", title: "Рішення й модулі" },
];

// Навігація між сторінками: посилання #/<сторінка>, без залежностей від роутера
export function Nav({ current }: { current: Page }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Розділи">
      {pages.map((p) => (
        <a
          key={p.id}
          href={`#/${p.id}`}
          aria-current={p.id === current ? "page" : undefined}
          className={cn("rounded-md border px-3 py-1.5 text-sm hover:bg-muted", p.id === current && "bg-primary text-primary-foreground hover:bg-primary")}
        >
          {p.title}
        </a>
      ))}
    </nav>
  );
}
