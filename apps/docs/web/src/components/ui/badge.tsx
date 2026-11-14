import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export const Badge = ({ className, ...p }: ComponentProps<"span">) => (
  <span className={cn("inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium", className)} {...p} />
);
