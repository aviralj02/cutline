/**
 * Two frames spliced with a vertical offset — film, and a cut.
 * Monochrome by design: it inherits currentColor so it works on any surface
 * and never competes with the accents, which carry meaning elsewhere.
 */
export function Mark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <rect x="3.5" y="2.5" width="6.5" height="13" rx="1.5" />
      <rect x="14" y="8.5" width="6.5" height="13" rx="1.5" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <Mark size={18} className="text-ink" />
      <span className="text-[15px] font-semibold leading-none tracking-[-.02em] text-ink">
        cutline
      </span>
    </span>
  );
}
