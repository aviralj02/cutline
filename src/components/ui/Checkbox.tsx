import type { ReactNode } from "react";
import { CheckIcon } from "./Icon";

/** A checkbox on the neutral ramp; the real input sits invisibly over the face, so every native behaviour stays. */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** A quieter line under the label. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Layout only. */
  className?: string;
}) {
  return (
    <label
      className={`group flex min-h-8 cursor-pointer items-start gap-2.5 py-2 ${
        disabled ? "pointer-events-none opacity-35" : ""
      } ${className}`}
    >
      <span className="relative grid size-4 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0"
        />
        {/* Neutral when ticked: amber belongs to the agent and the primary action. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none grid size-4 place-items-center rounded-[5px] border transition-[background-color,border-color,transform] duration-150 ease-out group-active:scale-90 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-solid peer-focus-visible:outline-leader ${
            checked ? "border-ink bg-ink" : "border-ink-3/70 bg-raised group-hover:border-ink-2"
          }`}
        >
          <CheckIcon
            size={12}
            className={`text-shell transition-[opacity,transform] duration-150 ease-out ${
              checked ? "scale-100 opacity-100" : "scale-50 opacity-0"
            }`}
          />
        </span>
      </span>
      <span className="min-w-0">
        <span
          className={`block text-[12.5px] leading-4 transition-colors duration-150 group-hover:text-ink ${
            checked ? "text-ink" : "text-ink-2"
          }`}
        >
          {label}
        </span>
        {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}
