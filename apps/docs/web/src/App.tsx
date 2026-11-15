import { useEffect, useState } from "react";
import { Page } from "./components/Page";
import { Nav, pages } from "./components/Nav";
import type { Page as PageId } from "./content";
import { data } from "./data";
import Overview from "./pages/Overview";
import Notes from "./pages/Notes";
import Agent from "./pages/Agent";
import Sites from "./pages/Sites";
import Decisions from "./pages/Decisions";

const views: Record<PageId, { subtitle?: string; View: () => React.JSX.Element }> = {
  overview: { View: Overview },
  notes: { subtitle: "Голосові, текстові й фото-нотатки: конвеєр, шари, можливості", View: Notes },
  agent: { subtitle: "Сесії OpenCode в контейнері: цикл, черга, чат, порти, GitHub", View: Agent },
  sites: { subtitle: "Публікація сайтів і MCP-сервіси власника", View: Sites },
  decisions: { subtitle: "ADR, модулі застосунків, прив'язки Cloudflare й документи", View: Decisions },
};

// Сторінка з хеша URL (#/agent); невідомий хеш веде на огляд
const fromHash = (): PageId => {
  const id = location.hash.replace(/^#\/?/, "");
  return pages.some((p) => p.id === id) ? (id as PageId) : "overview";
};

export default function App() {
  const [page, setPage] = useState(fromHash);
  useEffect(() => {
    const on = () => {
      setPage(fromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const { View, subtitle } = views[page];
  const title = pages.find((p) => p.id === page)!.title;
  return (
    <Page
      title={page === "overview" ? "Архітектура бота й агента" : `${title} · архітектура`}
      subtitle={`${subtitle ?? "Знімок main"} · коміт ${data.sha.slice(0, 7)} · ${data.date}`}
      nav={<Nav current={page} />}
    >
      <View />
    </Page>
  );
}
