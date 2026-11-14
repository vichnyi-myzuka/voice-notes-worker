import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Table = ({ className, ...p }: ComponentProps<"table">) => (
  <div className="w-full overflow-x-auto">
    <table className={cn("w-full text-sm", className)} {...p} />
  </div>
);
export const TableHead = ({ className, ...p }: ComponentProps<"th">) => (
  <th className={cn("h-10 border-b px-3 text-left align-middle font-medium text-muted-foreground", className)} {...p} />
);
export const TableRow = ({ className, ...p }: ComponentProps<"tr">) => <tr className={cn("border-b last:border-0 hover:bg-muted/50", className)} {...p} />;
export const TableCell = ({ className, ...p }: ComponentProps<"td">) => <td className={cn("px-3 py-2.5 align-middle", className)} {...p} />;
