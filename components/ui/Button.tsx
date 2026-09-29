import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "glass" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-pill)] font-semibold " +
  "transition duration-200 ease-[var(--ease-out-soft)] select-none " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-300 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // Dark text on Panta green: 6.6:1 (white on green would fail AA).
  primary:
    "bg-brand-500 text-ink-950 shadow-[var(--shadow-brand-glow)] hover:bg-brand-400 active:bg-brand-600 " +
    "bg-[linear-gradient(180deg,rgb(255_255_255/0.18),transparent)]",
  glass: "glass text-fg hover:border-white/20 hover:bg-white/[0.08]",
  ghost: "text-fg-muted hover:text-fg hover:bg-white/5",
  danger: "bg-coral-400/15 text-coral-400 border border-coral-400/30 hover:bg-coral-400/25",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

/** Class string for links styled as buttons. */
export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize };

export function Button({ variant = "primary", size = "md", className, type = "button", ...rest }: Props) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...rest} />;
}
