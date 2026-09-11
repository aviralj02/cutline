import type { ReactNode } from "react";
import { ChevronIcon } from "./Icon";

/**
 * Panel headings are sentence case at text size — not tracked-out capitals.
 * A label's job is to name the region, not to decorate it.
 */
export function PanelHeader({
  title,
  children,
  open,
  onToggle,
  controls,
}: {
  title: string;
  children?: ReactNode;
  /** With onToggle, the heading folds the panel; a folded panel is just this row. */
  open?: boolean;
  onToggle?: () => void;
  /** Id of the region the heading folds. */
  controls?: string;
}) {
  const heading = "text-[13px] font-semibold tracking-[-.01em] text-ink";
  return (
    <div className={`flex h-10 shrink-0 items-center gap-2 px-3 ${open === false ? "" : "border-b border-edge"}`}>
      <h2 className="shrink-0">
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={controls}
            className={`-ml-1.5 flex h-8 items-center gap-1 rounded-ctl px-1.5 transition-[background-color,transform] duration-150 hover:bg-white/[.07] active:scale-[.97] ${heading}`}
          >
            <ChevronIcon
              size={13}
              className={`text-ink-3 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
            />
            {title}
          </button>
        ) : (
          <span className={heading}>{title}</span>
        )}
      </h2>
      {/* min-w-0 lets a chip give way before anything spills out of a narrow rail. */}
      <div className="ml-auto flex min-w-0 items-center gap-1">{children}</div>
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`flex min-h-0 flex-col bg-panel ${className}`}>{children}</section>;
}

/**
 * Small status marker. The only pill in the system.
 *
 * One line, always: squeezed, it truncates rather than wrapping. A variant
 * name wrapped to three lines in the 290px rail and spilled out of the header.
 */
export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "leader";
}) {
  const tones = {
    neutral: "bg-raised text-ink-2",
    leader: "bg-leader/15 text-leader",
  };
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center rounded-full px-2 py-[3px] text-[11px] font-medium ${tones[tone]}`}>
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Tabular timecode. Never let digits reflow as the playhead moves. */
export function Timecode({
  children,
  dim = false,
  className = "",
}: {
  children: ReactNode;
  dim?: boolean;
  className?: string;
}) {
  return (
    <span className={`tnum font-mono text-[12px] ${dim ? "text-ink-3" : "text-ink-2"} ${className}`}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-0.5 font-mono text-[10px] font-normal text-ink-3">{children}</kbd>
  );
}

/** Empty screens are an invitation to act, so they say what to do next. */
export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="grid flex-1 place-items-center px-6 py-10 text-center">
      <div className="max-w-[26ch]">
        {icon && <div className="mb-2 flex justify-center text-ink-3">{icon}</div>}
        <p className="text-[13px] text-ink-2">{title}</p>
        {hint && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{hint}</p>}
      </div>
    </div>
  );
}
