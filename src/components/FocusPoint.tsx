"use client";

import { useCallback } from "react";
import type { Crop } from "@/lib/edl/types";

/**
 * The point a zoom pushes into, dragged on the picture itself.
 *
 * A zoom scales about this point, which means the point is the one place in
 * frame that does not move as the scale changes — so the marker sits exactly
 * where it lands, at any scale, and there is nothing to reconcile between the
 * control and the result.
 */
export default function FocusPoint({
  x,
  y,
  scale,
  crop,
  onChange,
  onCommit,
}: {
  x: number;
  y: number;
  scale: number;
  crop: Crop;
  onChange: (p: { x: number; y: number }) => void;
  onCommit: () => void;
}) {
  // The overlay covers the visible frame, which is the crop window rather
  // than the whole composition.
  const toView = (fx: number, fy: number) => ({
    left: ((fx - crop.x) / crop.w) * 100,
    top: ((fy - crop.y) / crop.h) * 100,
  });
  const toFrame = (px: number, py: number) => ({
    x: Math.min(1, Math.max(0, crop.x + px * crop.w)),
    y: Math.min(1, Math.max(0, crop.y + py * crop.h)),
  });

  const drag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const host = (e.currentTarget as HTMLElement).parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();

      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        onChange(toFrame((ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        onCommit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [onChange, onCommit, crop],
  );

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onChange({
      x: Math.min(1, Math.max(0, x + d[0] * step)),
      y: Math.min(1, Math.max(0, y + d[1] * step)),
    });
    onCommit();
  };

  const pos = toView(x, y);
  const offscreen = pos.left < 0 || pos.left > 100 || pos.top < 0 || pos.top > 100;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Sight lines to the edges. They make the position readable without
          numbers, and fade out so they never compete with the picture. */}
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-leader/25"
        style={{ left: `${pos.left}%` }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 h-px bg-leader/25"
        style={{ top: `${pos.top}%` }}
      />

      {/*
        The exact anchor is the centre of this control, so it is marked
        unambiguously: four ticks converging on a 3px core, with the ring left
        unfilled. A large filled disc reads as an area rather than a point, and
        a label hanging off it drags the eye away from the true centre.
      */}
      <button
        type="button"
        onPointerDown={drag}
        onKeyDown={onKey}
        aria-label={`Zoom focus. Arrow keys move it. Currently ${Math.round(x * 100)} percent across, ${Math.round(y * 100)} percent down.`}
        title="Drag to choose where the zoom pushes in"
        className="group absolute z-10 h-9 w-9 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full
                   transition-transform duration-150 hover:scale-110 active:scale-95"
        style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
      >
        <span className="absolute inset-[7px] rounded-full border-[1.5px] border-leader shadow-[0_1px_6px_rgba(0,0,0,.6)]" />
        {/* Ticks stop short of the core, leaving the centre readable. */}
        <span className="absolute left-1/2 top-0 h-[7px] w-[1.5px] -translate-x-1/2 rounded-full bg-leader" />
        <span className="absolute bottom-0 left-1/2 h-[7px] w-[1.5px] -translate-x-1/2 rounded-full bg-leader" />
        <span className="absolute left-0 top-1/2 h-[1.5px] w-[7px] -translate-y-1/2 rounded-full bg-leader" />
        <span className="absolute right-0 top-1/2 h-[1.5px] w-[7px] -translate-y-1/2 rounded-full bg-leader" />
        <span className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-leader shadow-[0_0_0_1.5px_rgba(0,0,0,.5)]" />
      </button>

      {/* Parked in the corner rather than hung off the marker, so it never
          biases where the centre looks like it is. */}
      <span className="tnum pointer-events-none absolute bottom-2 right-2 rounded-full bg-shell/85 px-2 py-0.5 font-mono text-[10px] text-leader backdrop-blur">
        {scale.toFixed(2)}× focus {Math.round(x * 100)}%, {Math.round(y * 100)}%
      </span>

      {offscreen && (
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-shell/90 px-2.5 py-1 text-[11px] text-ink-2 backdrop-blur">
          The focus point is outside the crop
        </span>
      )}
    </div>
  );
}
