"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { IconButton } from "./Button";
import { CloseIcon } from "./Icon";

/** The one modal surface, on the native <dialog>: focus trap, Escape and backdrop come free. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  initialFocus,
  closeLabel,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Where focus lands on opening. A confirmation puts it on the safe choice. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Draws a close control in the corner, with this name. */
  closeLabel?: string;
  /** Width only. */
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      initialFocus?.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      /* m-auto restores the centring that Tailwind's preflight zeroes. */
      className={`m-auto overflow-hidden rounded-panel border border-edge bg-panel p-0 text-ink
                  shadow-[0_24px_60px_rgba(0,0,0,.6)] backdrop:bg-black/55 backdrop:backdrop-blur-[2px] ${className}`}
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        <h2 id={titleId} className="min-w-0 flex-1 text-[14px] font-semibold tracking-[-.01em] text-ink">
          {title}
        </h2>
        {closeLabel && (
          <IconButton label={closeLabel} icon={<CloseIcon size={14} />} onClick={onClose} className="-mr-2 -mt-1.5" />
        )}
      </div>
      {children}
    </dialog>
  );
}
