"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "quiet" | "danger" | "destructive";
type Size = "sm" | "md";

/**
 * Every control answers a press. The scale-down is small enough to read as
 * the button taking the click rather than as an animation.
 */
const base =
  "inline-flex select-none items-center justify-center gap-1.5 rounded-ctl font-medium " +
  "transition-[background-color,color,transform,box-shadow] duration-150 " +
  "active:scale-[.97] disabled:pointer-events-none disabled:opacity-35";

const variants: Record<Variant, string> = {
  // Film-leader amber, for the one action that moves work forward.
  primary: "bg-leader text-black shadow-[0_1px_2px_rgba(0,0,0,.3)] hover:bg-[#f2bf46]",
  // A translucent wash rather than a fixed grey, so hover reads the same on
  // every surface this button lands on.
  quiet: "text-ink-2 hover:bg-white/[.07] hover:text-ink",
  // Grease-pencil red, only where something is removed.
  danger: "text-ink-2 hover:bg-grease/15 hover:text-grease",
  // The filled form, for confirming a destructive action outright.
  destructive: "bg-grease text-white shadow-[0_1px_2px_rgba(0,0,0,.3)] hover:bg-[#e0604e]",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[12.5px]",
  md: "h-9 px-3.5 text-[13px]",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "quiet", size = "sm", icon, children, className = "", ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {icon}
      {children}
    </button>
  );
});

/**
 * A control where the icon alone is unambiguous. Always labelled.
 *
 * Colour comes from `variant`, never from `className`. Two Tailwind colour
 * utilities on one element have equal specificity, so the compiled order
 * decides which wins — passing `text-black` alongside a default `text-ink-2`
 * silently lost, and the play triangle shipped grey on amber.
 */
export function IconButton({
  label,
  icon,
  variant = "quiet",
  active = false,
  round = false,
  nested = false,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
  /** `danger` is grease-pencil red on hover, only where something is removed. */
  variant?: "quiet" | "primary" | "danger";
  active?: boolean;
  /** Transport controls are circular, the way every player's are. */
  round?: boolean;
  /** Inside a field, 3px in: its 7px corner stays concentric with the field's 10px. */
  nested?: boolean;
}) {
  const tone =
    variant === "primary"
      ? "bg-leader text-black shadow-[0_1px_3px_rgba(0,0,0,.35)] hover:bg-[#f2bf46]"
      : variant === "danger"
        ? "text-ink-2 hover:bg-grease/15 hover:text-grease"
        : active
        ? "bg-white/[.09] text-ink"
        : "text-ink-2 hover:bg-white/[.07] hover:text-ink";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Disabled must look disabled, as on Button.
      className={`grid h-8 w-8 shrink-0 place-items-center transition-[background-color,color,transform] duration-150 active:scale-[.94] disabled:pointer-events-none disabled:opacity-35 ${
        round ? "rounded-full" : nested ? "rounded-sm" : "rounded-ctl"
      } ${tone} ${className}`}
      {...rest}
    >
      {icon}
    </button>
  );
}

/** Segmented choice — speed, aspect. One control, several mutually exclusive values. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  format = (v) => String(v),
  title,
  mono = true,
  wrap = false,
}: {
  options: readonly T[];
  /** Null when nothing is chosen yet. */
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  format?: (v: T) => string;
  title?: (v: T) => string;
  /** The mono face is for numbers; names read in the interface face. */
  mono?: boolean;
  /** Let a long set of names break onto a second row in a narrow rail. */
  wrap?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex items-center gap-0.5 rounded-ctl bg-white/[.05] p-1 ${wrap ? "flex-wrap" : ""}`}
    >
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={String(o)}
            type="button"
            onClick={() => onChange(o)}
            aria-pressed={on}
            title={title?.(o)}
            className={`rounded-sm px-2 py-1 transition-[background-color,color] duration-150 ${
              mono ? "tnum font-mono text-[11.5px]" : "text-[12px]"
            } ${
              on ? "bg-leader text-black" : "text-ink-2 hover:bg-white/[.07] hover:text-ink"
            }`}
          >
            {format(o)}
          </button>
        );
      })}
    </div>
  );
}
