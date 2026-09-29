import type { ComponentPropsWithoutRef, ElementType } from "react";
import { cn } from "./cn";

type Props<T extends ElementType> = {
  as?: T;
  /** glass = frosted (content moves beneath it); card = solid raised surface. */
  surface?: "glass" | "card";
} & ComponentPropsWithoutRef<T>;

/** Surface primitive. Glass is reserved for elements that float over content. */
export function GlassCard<T extends ElementType = "div">({ as, surface = "card", className, ...rest }: Props<T>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag
      className={cn(surface === "glass" ? "glass rounded-[var(--radius-card)]" : "card", "relative", className)}
      {...rest}
    />
  );
}
