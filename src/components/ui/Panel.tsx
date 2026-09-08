import type { ReactNode } from "react";

/**
 * Panel headings are sentence case at text size — not tracked-out capitals.
 * A label's job is to name the region, not to decorate it.
 */
export function PanelHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
      <h2 className="text-[13px] font-semibold tracking-[-.01em] text-ink">{title}</h2>
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`flex min-h-0 flex-col bg-panel ${className}`}>{children}</section>;
}

/** Small status marker. The only pill in the system. */
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
    <span className={`inline-flex items-center rounded-full px-2 py-[3px] text-[11px] font-medium ${tones[tone]}`}>
      {children}
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
