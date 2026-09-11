"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";

/**
 * A confirmation for something that cannot be taken back.
 *
 * Built on the native <dialog> so focus trapping, Escape, inertness of the
 * page behind it and the backdrop all come from the platform rather than from
 * code that has to be kept correct. Focus opens on the safe choice: a
 * destructive action should never be one stray Enter away.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const safeRef = useRef<HTMLButtonElement>(null);
  // More than one dialog can be mounted at once; a fixed id would name every
  // one of them by the first one's title.
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      safeRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape and the backdrop both mean "no".
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
      /* m-auto is load-bearing: a modal <dialog> is centred by the UA's own
         `inset:0; margin:auto`, and Tailwind's preflight zeroes that margin,
         which pins the dialog to the top-left corner. */
      className="m-auto max-w-[22rem] rounded-panel border border-edge bg-panel p-0 text-ink
                 shadow-[0_24px_60px_rgba(0,0,0,.6)] backdrop:bg-black/55 backdrop:backdrop-blur-[2px]"
    >
      <div className="p-4">
        <h2 id={titleId} className="text-[14px] font-semibold tracking-[-.01em] text-ink">
          {title}
        </h2>
        <div className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{body}</div>

        <div className="mt-4 flex justify-end gap-1.5">
          <Button ref={safeRef} size="md" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button size="md" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
