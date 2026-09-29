import type { ComponentPropsWithoutRef, ElementType } from "react";
import { cn } from "./cn";

type Props<T extends ElementType> = {
  as?: T;
  strong?: boolean; // denser, more opaque glass for dialogs/overlays
  interactive?: boolean; // subtle lift on hover
} & ComponentPropsWithoutRef<T>;

/** Frosted translucent panel: backdrop blur, 1px light border, soft inner highlight. */
export function GlassCard<T extends ElementType = "div">({ as, strong, interactive, className, ...rest }: Props<T>) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag
      className={cn(
        strong ? "glass-strong" : "glass",
        "relative rounded-[var(--radius-glass)]",
        interactive &&
          "transition duration-300 ease-[var(--ease-out-soft)] hover:-translate-y-0.5 hover:border-white/15 hover:shadow-[var(--shadow-glass-hover)]",
        className,
      )}
      {...rest}
    />
  );
}
