"use client";

import { useRef } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/** Confirms what can't be undone; focus opens on the safe choice. */
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
  const safeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onClose={onCancel} title={title} initialFocus={safeRef} className="max-w-[22rem]">
      <div className="px-4 pb-4">
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
    </Dialog>
  );
}
