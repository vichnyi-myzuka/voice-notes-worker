import raw from "./generated.json";
import type { Generated } from "../../scripts/lib";

// generated.json пише scripts/generate.ts; явний тип потрібен, бо порожні масиви (напр. merges без історії git) JSON виводить як never[]
export const data = raw as Generated;
export const blob = (path: string) => `${data.repoUrl}/blob/main/${path}`;
export const countFiles = (a: Generated["apps"][number]) => a.modules.reduce((s, m) => s + m.files.length, 0);
