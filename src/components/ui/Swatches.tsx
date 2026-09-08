"use client";

/**
 * Fade colours. The set is short on purpose — a fade resolves to one of a
 * handful of values in practice, and an open picker for the common case turns
 * a one-click choice into a colour-mixing task. The custom well is there for
 * the case the list does not cover.
 */
export function Swatches({
  colors,
  value,
  onChange,
  label,
}: {
  colors: Array<{ name: string; value: string }>;
  value: string;
  onChange: (hex: string) => void;
  label: string;
}) {
  const known = colors.some((c) => c.value.toLowerCase() === value.toLowerCase());

  return (
    <div role="group" aria-label={label} className="flex items-center gap-1.5">
      {colors.map((c) => {
        const on = c.value.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            aria-label={c.name}
            aria-pressed={on}
            title={c.name}
            className={`h-5 w-5 rounded-full transition-transform duration-150 active:scale-90 ${
              on ? "scale-110 ring-2 ring-leader ring-offset-2 ring-offset-panel" : "hover:scale-110"
            }`}
            /* A hairline keeps near-black and near-white swatches from
               disappearing into the surfaces on either side. */
            style={{ background: c.value, boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18)" }}
          />
        );
      })}

      <label
        title="Pick any colour"
        className={`relative h-5 w-5 cursor-pointer overflow-hidden rounded-full transition-transform hover:scale-110 ${
          known ? "" : "scale-110 ring-2 ring-leader ring-offset-2 ring-offset-panel"
        }`}
        style={{
          background: known
            ? "conic-gradient(from 0deg, #d2503f, #e0a92e, #7cc4a4, #8fa8e0, #d99ac0, #d2503f)"
            : value,
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,.18)",
        }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={`${label}: custom colour`}
        />
      </label>
    </div>
  );
}

/** A labelled slider for continuous effect parameters. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  format,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[12px] text-ink-2">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-white/15 accent-leader
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:bg-leader [&::-webkit-slider-thumb]:shadow-[0_1px_3px_rgba(0,0,0,.5)]"
      />
      <span className="tnum w-10 shrink-0 text-right font-mono text-[11px] text-ink-3">
        {format ? format(value) : value.toFixed(2)}
      </span>
    </label>
  );
}
