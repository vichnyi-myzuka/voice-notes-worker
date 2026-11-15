import type { PayloadFile } from "./payload";
import f0 from "../../../../payload/report-site/index.html.tpl";
import f1 from "../../../../payload/report-site/package.json.tpl";
import f2 from "../../../../payload/report-site/src/App.tsx.tpl";
import f3 from "../../../../payload/report-site/src/components/ChartCard.tsx.tpl";
import f4 from "../../../../payload/report-site/src/components/Diagram.tsx.tpl";
import f5 from "../../../../payload/report-site/src/components/Kpi.tsx.tpl";
import f6 from "../../../../payload/report-site/src/components/Page.tsx.tpl";
import f7 from "../../../../payload/report-site/src/components/ThemeToggle.tsx.tpl";
import f8 from "../../../../payload/report-site/src/components/ui/badge.tsx.tpl";
import f9 from "../../../../payload/report-site/src/components/ui/card.tsx.tpl";
import f10 from "../../../../payload/report-site/src/components/ui/table.tsx.tpl";
import f11 from "../../../../payload/report-site/src/data.ts.tpl";
import f12 from "../../../../payload/report-site/src/index.css.tpl";
import f13 from "../../../../payload/report-site/src/lib/utils.ts.tpl";
import f14 from "../../../../payload/report-site/src/main.tsx.tpl";
import f15 from "../../../../payload/report-site/tsconfig.json.tpl";
import f16 from "../../../../payload/report-site/vite.config.ts.tpl";

// Шаблон сайту-звіту (скрипт new-report-site копіює його в нову теку): файли лежать у payload/report-site/ з суфіксом .tpl, щоб
// лінтер і tsc не сприймали їх як код воркера. Воркер розкладає їх у контейнер разом з рештою payload.
export const REPORT_SITE_DIR = "/usr/local/share/report-site";

const FILES: [string, string][] = [
	["index.html", f0],
	["package.json", f1],
	["src/App.tsx", f2],
	["src/components/ChartCard.tsx", f3],
	["src/components/Diagram.tsx", f4],
	["src/components/Kpi.tsx", f5],
	["src/components/Page.tsx", f6],
	["src/components/ThemeToggle.tsx", f7],
	["src/components/ui/badge.tsx", f8],
	["src/components/ui/card.tsx", f9],
	["src/components/ui/table.tsx", f10],
	["src/data.ts", f11],
	["src/index.css", f12],
	["src/lib/utils.ts", f13],
	["src/main.tsx", f14],
	["tsconfig.json", f15],
	["vite.config.ts", f16],
];

export const REPORT_SITE_FILES: PayloadFile[] = FILES.map(([path, content]) => ({ path: `${REPORT_SITE_DIR}/${path}`, mode: "644", content }));
