"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, edlOf } from "@/lib/store";
import { duration, fmt, placed } from "@/lib/edl/query";
import { mediaUrl } from "@/lib/media/opfs";
import type { Edl } from "@/lib/edl/types";

/** Load one hidden <video> per source file, backed by OPFS object URLs. */
function useVideoPool(mediaIds: string[]) {
  const pool = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [, force] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const id of mediaIds) {
        if (pool.current.has(id)) continue;
        const url = await mediaUrl(id);
        if (!url || cancelled) continue;
        const v = document.createElement("video");
        v.src = url;
        v.preload = "auto";
        v.playsInline = true;
        pool.current.set(id, v);
        force((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mediaIds]);

  return pool;
}

function drawText(ctx: CanvasRenderingContext2D, edl: Edl, t: number, w: number, h: number) {
  for (const item of edl.text) {
    if (t < item.at || t >= item.at + item.dur) continue;
    const scale = h / 1080;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    if (item.style === "title") {
      ctx.font = `700 ${Math.round(64 * scale)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,.6)";
      ctx.shadowBlur = 16 * scale;
      ctx.fillStyle = "#fff";
      ctx.fillText(item.content, w / 2, h / 2);
    } else if (item.style === "lower-third") {
      const pad = 24 * scale;
      ctx.font = `600 ${Math.round(38 * scale)}px ui-sans-serif, system-ui, sans-serif`;
      const width = ctx.measureText(item.content).width;
      const y = h - 140 * scale;
      ctx.fillStyle = "rgba(10,10,12,.78)";
      ctx.fillRect(pad, y - 46 * scale, width + pad * 2, 64 * scale);
      ctx.fillStyle = "#f5b544";
      ctx.fillRect(pad, y - 46 * scale, 4 * scale, 64 * scale);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.fillText(item.content, pad * 2, y);
    } else {
      ctx.font = `600 ${Math.round(34 * scale)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      const width = ctx.measureText(item.content).width;
      const y = h - 70 * scale;
      ctx.fillStyle = "rgba(10,10,12,.7)";
      ctx.fillRect(w / 2 - width / 2 - 16 * scale, y - 34 * scale, width + 32 * scale, 48 * scale);
      ctx.fillStyle = "#fff";
      ctx.fillText(item.content, w / 2, y);
    }
    ctx.restore();
  }
}

export default function Preview() {
  const repo = useStore((s) => s.repo);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setPlaying = useStore((s) => s.setPlaying);
  const media = useStore((s) => s.media);

  const edl = useMemo(() => edlOf(repo), [repo]);
  const total = duration(edl);
  const mediaIds = useMemo(() => media.map((m) => m.id), [media]);
  const pool = useVideoPool(mediaIds);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Refs so the animation loop never restarts on a state change.
  const headRef = useRef(playhead);
  const playRef = useRef(playing);
  const edlRef = useRef(edl);
  headRef.current = playhead;
  playRef.current = playing;
  edlRef.current = edl;

  useEffect(() => {
    let raf = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      const cur = edlRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const spots = placed(cur);
      const t = headRef.current;
      const spot = spots.find((p) => t >= p.start && t < p.end) ?? null;

      // Anything that is not the active source must be silent and paused.
      for (const [id, v] of pool.current) {
        if (!spot || id !== spot.clip.src) {
          if (!v.paused) v.pause();
        }
      }

      if (!spot) {
        ctx.fillStyle = "#0b0b0d";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (playRef.current) setPlaying(false);
        return;
      }

      const v = pool.current.get(spot.clip.src);
      if (!v || !v.videoWidth) return;

      const rate = spot.clip.speed ?? 1;
      const wanted = spot.clip.in + (t - spot.start) * rate;

      if (playRef.current) {
        v.playbackRate = rate;
        if (v.paused) void v.play().catch(() => setPlaying(false));
        // A cut is a seek: when the source passes this clip's out-point, jump
        // to whatever the next clip is instead of playing through it.
        if (v.currentTime >= spot.clip.out - 0.03) {
          const next = spots[spot.index + 1];
          if (!next) {
            setPlaying(false);
            setPlayhead(spot.end, true);
          } else {
            const nv = pool.current.get(next.clip.src);
            if (nv) nv.currentTime = next.clip.in;
            setPlayhead(next.start + 0.001, true);
          }
        } else {
          // The video element is the clock while it is inside a clip; that
          // keeps audio and picture locked together.
          setPlayhead(spot.start + (v.currentTime - spot.clip.in) / rate, true);
        }
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - wanted) > 0.05) v.currentTime = wanted;
      }

      // Letterbox the source into the canvas.
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      ctx.fillStyle = "#0b0b0d";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(v, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      drawText(ctx, cur, t, cw, ch);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pool, setPlayhead, setPlaying]);

  // Pause every source when playback stops or the component unmounts.
  useEffect(() => {
    if (playing) return;
    for (const [, v] of pool.current) if (!v.paused) v.pause();
  }, [playing, pool]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-[#0b0b0d] p-4">
        <canvas
          ref={canvasRef}
          width={1280}
          height={720}
          className="max-h-full max-w-full rounded-md shadow-[0_8px_40px_rgba(0,0,0,.6)] ring-1 ring-white/5"
          style={{ aspectRatio: `${edl.width} / ${edl.height}` }}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-white/8 bg-[#111114] px-4 py-2.5">
        <button
          onClick={() => setPlaying(!playing)}
          className="grid h-9 w-9 place-items-center rounded-full bg-[#f5b544] text-black transition hover:bg-[#ffc65e]"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor">
              <rect x="0" y="0" width="4" height="13" rx="1" />
              <rect x="8" y="0" width="4" height="13" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="13" viewBox="0 0 12 13" fill="currentColor">
              <path d="M1 1.2c0-.8.9-1.3 1.6-.9l8 5.3c.6.4.6 1.4 0 1.8l-8 5.3c-.7.4-1.6-.1-1.6-.9V1.2z" />
            </svg>
          )}
        </button>
        <span className="font-mono text-xs tabular-nums text-white/70">
          {fmt(playhead)} <span className="text-white/25">/ {fmt(total)}</span>
        </span>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-white/35">
          <span>{edl.clips.length} clip{edl.clips.length === 1 ? "" : "s"}</span>
          <span className="text-white/15">·</span>
          <span>{edl.width}×{edl.height}</span>
        </div>
      </div>
    </div>
  );
}
