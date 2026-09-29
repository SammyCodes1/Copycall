import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] " +
  "font-sans font-semibold tracking-[-0.005em] transition-[background-color,border-color,color,transform] duration-150 " +
  "ease-[var(--ease-out-soft)] active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-brand-300 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // Dark ink on Panta green = 6.6:1 (white on this green would fail AA).
  primary:
    "bg-brand-500 text-ink-950 shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_1px_0_rgb(0_0_0/0.5)] " +
    "hover:bg-brand-400 active:bg-brand-600 active:shadow-[var(--shadow-press)]",
  secondary: "border border-line-strong bg-white/[0.02] text-fg hover:border-white/25 hover:bg-white/[0.05]",
  ghost: "text-fg-muted hover:bg-white/[0.05] hover:text-fg",
  danger: "border border-coral-400/35 text-coral-400 hover:bg-coral-400/10",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

/** Class string for links styled as buttons. */
export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: Props) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...rest} />;
}
