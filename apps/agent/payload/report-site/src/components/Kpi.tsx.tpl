import { Card, CardContent, CardDescription } from "./ui/card";
import { cn } from "../lib/utils";

// Показник: велике число, підпис і (необов'язково) зміна. good=false фарбує зміну як погану (напр., витрати зросли).
export function Kpi({ label, value, delta, good = true }: { label: string; value: string; delta?: string; good?: boolean }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <CardDescription>{label}</CardDescription>
        <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
        {delta && <div className={cn("text-xs font-medium", good ? "text-positive" : "text-negative")}>{delta}</div>}
      </CardContent>
    </Card>
  );
}
