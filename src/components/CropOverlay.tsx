"use client";

import { useCallback, useRef } from "react";
import type { Crop } from "@/lib/edl/types";

type Handle = "nw" | "ne" | "sw" | "se" | "move";

/**
 * Crop handles drawn over the full frame. While cropping, the preview shows
 * everything — you cannot choose a framing from inside the framing.
 */
export default function CropOverlay({
  crop,
  onChange,
  onCommit,
}: {
  crop: Crop;
  onChange: (c: Crop) => void;
  onCommit: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  const drag = useCallback(
    (handle: Handle) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const host = boxRef.current?.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const start = { ...crop };
      const originX = e.clientX;
      const originY = e.clientY;
      const MIN = 0.06;

      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - originX) / rect.width;
        const dy = (ev.clientY - originY) / rect.height;
        let { x, y, w, h } = start;

        if (handle === "move") {
          x = Math.min(1 - w, Math.max(0, start.x + dx));
          y = Math.min(1 - h, Math.max(0, start.y + dy));
        } else {
          const east = handle === "ne" || handle === "se";
          const south = handle === "se" || handle === "sw";
          if (east) w = Math.max(MIN, Math.min(1 - start.x, start.w + dx));
          else {
            const right = start.x + start.w;
            x = Math.max(0, Math.min(right - MIN, start.x + dx));
            w = right - x;
          }
          if (south) h = Math.max(MIN, Math.min(1 - start.y, start.h + dy));
          else {
            const bottom = start.y + start.h;
            y = Math.max(0, Math.min(bottom - MIN, start.y + dy));
            h = bottom - y;
          }
        }
        onChange({ x, y, w, h });
      };

      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onCommit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [crop, onChange, onCommit],
  );

  /** Arrow keys move the frame; with shift they resize it from the corner. */
  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.altKey ? 0.005 : 0.02;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      const [ux, uy] = d;
      if (e.shiftKey) {
        onChange({
          ...crop,
          w: Math.max(0.06, Math.min(1 - crop.x, crop.w + ux * step)),
          h: Math.max(0.06, Math.min(1 - crop.y, crop.h + uy * step)),
        });
      } else {
        onChange({
          ...crop,
          x: Math.min(1 - crop.w, Math.max(0, crop.x + ux * step)),
          y: Math.min(1 - crop.h, Math.max(0, crop.y + uy * step)),
        });
      }
      onCommit();
    },
    [crop, onChange, onCommit],
  );

  const pc = (n: number) => `${n * 100}%`;
  const corners: Array<[Handle, string, string, string]> = [
    ["nw", "top-[3px] left-[3px]", "nwse-resize", "top left"],
    ["ne", "top-[3px] right-[3px]", "nesw-resize", "top right"],
    ["sw", "bottom-[3px] left-[3px]", "nesw-resize", "bottom left"],
    ["se", "bottom-[3px] right-[3px]", "nwse-resize", "bottom right"],
  ];

  return (
    <div className="absolute inset-0" role="group" aria-label="Crop frame">
      {/* Everything outside the frame dims, so the kept area reads instantly. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/55"
        style={{
          clipPath: `polygon(0% 0%, 0% 100%, ${pc(crop.x)} 100%, ${pc(crop.x)} ${pc(crop.y)}, ${pc(
            crop.x + crop.w,
          )} ${pc(crop.y)}, ${pc(crop.x + crop.w)} ${pc(crop.y + crop.h)}, ${pc(crop.x)} ${pc(
            crop.y + crop.h,
          )}, ${pc(crop.x)} 100%, 100% 100%, 100% 0%)`,
        }}
      />

      <div
        ref={boxRef}
        onPointerDown={drag("move")}
        onKeyDown={onKey}
        role="application"
        aria-label="Crop area. Arrow keys move it, shift and arrow keys resize it."
        tabIndex={0}
        className="absolute cursor-move rounded-[4px] ring-1 ring-white/85 focus-visible:ring-2 focus-visible:ring-leader"
        style={{ left: pc(crop.x), top: pc(crop.y), width: pc(crop.w), height: pc(crop.h) }}
      >
        {/* Thirds, the way a viewfinder shows them. */}
        <div className="pointer-events-none absolute inset-0 opacity-45">
          <span className="absolute inset-y-0 left-1/3 w-px bg-white/60" />
          <span className="absolute inset-y-0 left-2/3 w-px bg-white/60" />
          <span className="absolute inset-x-0 top-1/3 h-px bg-white/60" />
          <span className="absolute inset-x-0 top-2/3 h-px bg-white/60" />
        </div>

        {corners.map(([h, pos, cursor, spoken]) => (
          <button
            key={h}
            type="button"
            onPointerDown={drag(h)}
            onKeyDown={onKey}
            style={{ cursor }}
            aria-label={`Resize crop from the ${spoken} corner`}
            className={`absolute h-[16px] w-[16px] rounded-[4px] border-2 border-white bg-white/15 shadow-[0_1px_5px_rgba(0,0,0,.7)] backdrop-blur-[1px] transition-transform hover:scale-110 ${pos}`}
          />
        ))}
      </div>
    </div>
  );
}
