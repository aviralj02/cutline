"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useStore, edlOf } from "@/lib/store";
import { duration, fmt } from "@/lib/edl/query";
import {
  EndIcon, IconButton, NextFrameIcon, PauseIcon, PlayIcon, PrevFrameIcon,
  StartIcon, Timecode,
} from "@/components/ui";

export default function Transport() {
  const repo = useStore((s) => s.repo);
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const playhead = useStore((s) => s.playhead);
  const setPlayhead = useStore((s) => s.setPlayhead);

  const edl = useMemo(() => edlOf(repo), [repo]);
  const total = duration(edl);
  const frame = 1 / edl.fps;

  const step = useCallback(
    (frames: number) => {
      setPlaying(false);
      setPlayhead(Math.max(0, Math.min(total, playhead + frames * frame)));
    },
    [frame, playhead, setPlayhead, setPlaying, total],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      // Alt+Arrow reorders the selected clip on the timeline; the playhead
      // must stay put, or one keystroke does two unrelated things.
      if (e.altKey) return;
      // Shift jumps a second, the way a jog wheel coarsens.
      if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -edl.fps : -1); }
      if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? edl.fps : 1); }
      if (e.key === "Home") { e.preventDefault(); setPlaying(false); setPlayhead(0); }
      if (e.key === "End") { e.preventDefault(); setPlaying(false); setPlayhead(total); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edl.fps, setPlayhead, setPlaying, step, total]);

  const atStart = playhead <= 0.001;
  const atEnd = total > 0 && playhead >= total - 0.001;

  return (
    <div className="flex items-center gap-1 rounded-full border border-edge bg-raised/95 py-1 pl-2 pr-3 shadow-[0_6px_20px_rgba(0,0,0,.45)] backdrop-blur">
      <IconButton
        label="Go to start"
        icon={<StartIcon size={14} />}
        disabled={atStart}
        onClick={() => { setPlaying(false); setPlayhead(0); }}
        round
        className="!h-7 !w-7"
      />
      <IconButton
        label="Back one frame"
        icon={<PrevFrameIcon size={14} />}
        disabled={atStart}
        onClick={() => step(-1)}
        round
        className="!h-7 !w-7"
      />
      <IconButton
        round
        variant="primary"
        label={playing ? "Pause" : "Play"}
        onClick={() => setPlaying(!playing)}
        icon={playing ? <PauseIcon size={15} /> : <PlayIcon size={15} className="translate-x-[1px]" />}
        className="mx-0.5"
      />
      <IconButton
        label="Forward one frame"
        icon={<NextFrameIcon size={14} />}
        disabled={atEnd}
        onClick={() => step(1)}
        round
        className="!h-7 !w-7"
      />
      <IconButton
        label="Go to end"
        icon={<EndIcon size={14} />}
        disabled={atEnd}
        onClick={() => { setPlaying(false); setPlayhead(total); }}
        round
        className="!h-7 !w-7"
      />

      <span className="mx-1 h-4 w-px bg-edge" />
      <Timecode className="!text-[12.5px] text-ink">{fmt(playhead)}</Timecode>
      <Timecode dim>/ {fmt(total)}</Timecode>
    </div>
  );
}
