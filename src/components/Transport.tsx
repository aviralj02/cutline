"use client";

import { useEffect, useMemo } from "react";
import { useStore, edlOf } from "@/lib/store";
import { duration, fmt } from "@/lib/edl/query";
import {
  EndIcon, IconButton, PauseIcon, PlayIcon, SeekBackIcon, SeekForwardIcon,
  StartIcon, Timecode,
} from "@/components/ui";

const SEEK = 5;

// Moves the playhead by seconds; playback carries on from the new spot.
function seekBy(secs: number) {
  const { repo, playhead, playing, setPlayhead } = useStore.getState();
  const total = duration(edlOf(repo));
  setPlayhead(Math.max(0, Math.min(total, playhead + secs)), playing);
}

export default function Transport() {
  const repo = useStore((s) => s.repo);
  const playing = useStore((s) => s.playing);
  const setPlaying = useStore((s) => s.setPlaying);
  const playhead = useStore((s) => s.playhead);
  const setPlayhead = useStore((s) => s.setPlayhead);

  const edl = useMemo(() => edlOf(repo), [repo]);
  const total = duration(edl);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      // Alt+Arrow reorders the selected clip on the timeline; the playhead must stay put.
      if (e.altKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const s = useStore.getState();
      const d = duration(edlOf(s.repo));
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      // Plain arrows seek five seconds; Shift steps one frame for exact placement.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (e.shiftKey) {
          s.setPlaying(false);
          s.setPlayhead(Math.max(0, Math.min(d, s.playhead + dir / edlOf(s.repo).fps)));
        } else seekBy(dir * SEEK);
      }
      if (e.key === "Home") { s.setPlaying(false); s.setPlayhead(0); }
      if (e.key === "End") { s.setPlaying(false); s.setPlayhead(d); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const atStart = playhead <= 0.001;
  const atEnd = total > 0 && playhead >= total - 0.001;

  return (
    <div className="flex select-none items-center gap-1 rounded-full border border-edge bg-raised/95 py-1 pl-2 pr-3 shadow-[0_6px_20px_rgba(0,0,0,.45)] backdrop-blur">
      <IconButton
        label="Go to start"
        icon={<StartIcon size={14} />}
        disabled={atStart}
        onClick={() => { setPlaying(false); setPlayhead(0); }}
        round
        className="!h-7 !w-7"
      />
      <IconButton
        label="Back 5 seconds"
        icon={<SeekBackIcon size={14} />}
        disabled={atStart}
        onClick={() => seekBy(-SEEK)}
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
        label="Forward 5 seconds"
        icon={<SeekForwardIcon size={14} />}
        disabled={atEnd}
        onClick={() => seekBy(SEEK)}
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
