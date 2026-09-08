"use client";

import { useCallback, useMemo, useRef } from "react";
import { useStore, edlOf } from "@/lib/store";
import { duration, fmt, placed } from "@/lib/edl/query";
import { deleteClip, splitAt } from "@/lib/edl/ops";

const CLIP_COLORS = ["#f5b544", "#7cc4a4", "#8fa8e0", "#d99ac0", "#c9b078"];

export default function Timeline() {
  const repo = useStore((s) => s.repo);
  const playhead = useStore((s) => s.playhead);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const waveforms = useStore((s) => s.waveforms);
  const selected = useStore((s) => s.selectedClip);
  const select = useStore((s) => s.select);
  const apply = useStore((s) => s.apply);
  const media = useStore((s) => s.media);

  const edl = useMemo(() => edlOf(repo), [repo]);
  const spots = useMemo(() => placed(edl), [edl]);
  const total = duration(edl);
  const trackRef = useRef<HTMLDivElement>(null);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !total) return;
      const rect = el.getBoundingClientRect();
      setPlayhead(((clientX - rect.left) / rect.width) * total);
    },
    [setPlayhead, total],
  );

  const scrub = useCallback(
    (e: React.PointerEvent) => {
      seekFromEvent(e.clientX);
      const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [seekFromEvent],
  );

  const pct = (t: number) => (total ? (t / total) * 100 : 0);

  // Ruler ticks at a readable density for the current length.
  const step = total > 600 ? 60 : total > 120 ? 30 : total > 40 ? 10 : total > 12 ? 5 : 1;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);

  if (!total) {
    return (
      <div className="grid h-40 place-items-center border-t border-white/8 bg-[#0e0e11] text-xs text-white/30">
        Nothing on the timeline
      </div>
    );
  }

  return (
    <div className="border-t border-white/8 bg-[#0e0e11]">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5">
        <span className="text-[11px] font-medium tracking-wide text-white/40">TIMELINE</span>
        <div className="ml-auto flex gap-1.5">
          <button
            onClick={() => apply(splitAt(edl, playhead), `Split at ${fmt(playhead)}`)}
            className="rounded border border-white/10 px-2 py-1 text-[11px] text-white/60 transition hover:border-white/25 hover:text-white"
          >
            Split at playhead
          </button>
          <button
            disabled={!selected}
            onClick={() => selected && apply(deleteClip(edl, selected), "Delete clip")}
            className="rounded border border-white/10 px-2 py-1 text-[11px] text-white/60 transition hover:border-white/25 hover:text-white disabled:opacity-30 disabled:hover:border-white/10"
          >
            Delete clip
          </button>
        </div>
      </div>

      <div className="relative px-4 pb-4">
        <div className="relative mb-1 h-4 select-none">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-0 -translate-x-1/2 font-mono text-[10px] tabular-nums text-white/25"
              style={{ left: `${pct(t)}%` }}
            >
              {fmt(t)}
            </span>
          ))}
        </div>

        <div
          ref={trackRef}
          onPointerDown={scrub}
          className="relative h-20 cursor-ew-resize touch-none overflow-hidden rounded-md bg-black/40 ring-1 ring-white/8"
        >
          {spots.map((p) => {
            const color = CLIP_COLORS[p.index % CLIP_COLORS.length];
            const wave = waveforms[p.clip.src] ?? [];
            const mediaDur = media.find((m) => m.id === p.clip.src)?.duration || p.clip.out;
            const isSel = selected === p.clip.id;
            return (
              <div
                key={p.clip.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  select(p.clip.id);
                  seekFromEvent(e.clientX);
                }}
                title={`${fmt(p.start)}–${fmt(p.end)} · source ${fmt(p.clip.in)}–${fmt(p.clip.out)}`}
                className="absolute inset-y-0 overflow-hidden border-r border-black/60"
                style={{
                  left: `${pct(p.start)}%`,
                  width: `${pct(p.end - p.start)}%`,
                  background: `linear-gradient(${color}22, ${color}0f)`,
                  boxShadow: isSel ? `inset 0 0 0 2px ${color}` : `inset 0 0 0 1px ${color}44`,
                }}
              >
                {/* Waveform slice for this clip's source window. */}
                <svg className="absolute inset-x-0 bottom-0 h-12 w-full" preserveAspectRatio="none" viewBox="0 0 100 40">
                  {wave.length > 0 &&
                    Array.from({ length: 60 }, (_, i) => {
                      const frac = i / 60;
                      const srcT = p.clip.in + (p.clip.out - p.clip.in) * frac;
                      const idx = Math.floor((srcT / (mediaDur || 1)) * wave.length);
                      const amp = wave[Math.min(wave.length - 1, Math.max(0, idx))] ?? 0;
                      const h = Math.max(0.6, Math.min(1, amp * 2.4) * 34);
                      return (
                        <rect
                          key={i}
                          x={frac * 100}
                          y={38 - h}
                          width={100 / 60 - 0.25}
                          height={h}
                          fill={color}
                          opacity={0.55}
                        />
                      );
                    })}
                </svg>
                <span className="pointer-events-none absolute left-1.5 top-1 font-mono text-[10px] text-white/50">
                  {p.index + 1}
                </span>
              </div>
            );
          })}

          {edl.text.map((t) => (
            <div
              key={t.id}
              title={t.content}
              className="pointer-events-none absolute top-0 h-2 rounded-b bg-white/70"
              style={{ left: `${pct(t.at)}%`, width: `${Math.max(0.4, pct(t.dur))}%` }}
            />
          ))}

          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-white"
            style={{ left: `${pct(playhead)}%` }}
          >
            <div className="absolute -left-[5px] -top-px h-2.5 w-2.5 rotate-45 bg-white" />
          </div>
        </div>
      </div>
    </div>
  );
}
