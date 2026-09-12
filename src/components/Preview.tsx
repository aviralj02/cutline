"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, useEdl } from "@/lib/store";
import { FULL_FRAME, cropOf, duration, fmt, isCropped, isSlug, outputSize, placed, soundsOf } from "@/lib/edl/query";
import { mediaUrl } from "@/lib/media/opfs";
import { composeFrame } from "@/lib/render/compose";
import type { Edl } from "@/lib/edl/types";
import { findEffect, resetCrop, setCrop, setCropAspect, updateEffect } from "@/lib/edl/ops";
import type { Crop } from "@/lib/edl/types";
import CropOverlay from "./CropOverlay";
import FocusPoint from "./FocusPoint";
import { Button, Chip, CropIcon, IconButton, Kbd, PauseIcon, PlayIcon, ResetIcon, Timecode } from "@/components/ui";

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

/** One <audio> element per sound item, created as items appear and dropped as they go. */
function useSoundPool(edl: Edl) {
  const pool = useRef<Map<string, HTMLAudioElement>>(new Map());
  const key = soundsOf(edl).map((s) => `${s.id}:${s.src}`).join(",");
  useEffect(() => {
    let cancelled = false;
    const wanted = key ? key.split(",").map((p) => p.split(":") as [string, string]) : [];
    const keep = new Set(wanted.map(([id]) => id));
    for (const [id, el] of pool.current) {
      if (keep.has(id)) continue;
      el.pause();
      pool.current.delete(id);
    }
    (async () => {
      for (const [id, src] of wanted) {
        if (pool.current.has(id)) continue;
        const url = await mediaUrl(src);
        if (!url || cancelled) continue;
        const el = new Audio(url);
        el.preload = "auto";
        pool.current.set(id, el);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);
  useEffect(() => {
    const els = pool.current;
    return () => els.forEach((el) => el.pause());
  }, []);
  return pool;
}

export default function Preview() {
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const setPlaying = useStore((s) => s.setPlaying);
  const media = useStore((s) => s.media);
  const apply = useStore((s) => s.apply);
  const cropping = useStore((s) => s.cropping);
  const setCropping = useStore((s) => s.setCropping);
  const selectedEffect = useStore((s) => s.selectedEffect);
  const setDraft = useStore((s) => s.setDraft);
  const commitDraft = useStore((s) => s.commitDraft);

  const edl = useEdl();
  const crop = cropOf(edl);
  const out = outputSize(edl);
  // While cropping you need to see what you are excluding, so the gate shows
  // the whole frame and the handles sit on top of it.
  const view = cropping ? { width: edl.width, height: edl.height } : out;
  const [cropDraft, setCropDraft] = useState<Crop | null>(null);
  const live = cropDraft ?? crop;

  // The focal target replaces a pair of X/Y sliders: you point at the thing
  // you want to push into, on the thing itself.
  const zoomBeingEdited = useMemo(() => {
    if (!selectedEffect || cropping) return null;
    const item = findEffect(edl, selectedEffect);
    return item && item.kind === "zoom" ? item : null;
  }, [edl, selectedEffect, cropping]);
  const total = duration(edl);
  const mediaIds = useMemo(() => media.filter((m) => m.kind !== "sound").map((m) => m.id), [media]);
  const pool = useVideoPool(mediaIds);
  const sounds = useSoundPool(edl);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const headRef = useRef(playhead);
  const playRef = useRef(playing);
  const edlRef = useRef(edl);
  const frameRef = useRef({ crop: live, cropping });
  headRef.current = playhead;
  playRef.current = playing;
  edlRef.current = edl;
  frameRef.current = { crop: live, cropping };

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      const cur = edlRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const spots = placed(cur);
      const t = headRef.current;
      const spot = spots.find((p) => t >= p.start && t < p.end) ?? null;
      const gap = !!spot && isSlug(spot.clip);
      const tick = last === null ? 0 : (now - last) / 1000;
      last = now;

      for (const [id, v] of pool.current) {
        v.muted = !!cur.videoMuted;
        if (!spot || gap || id !== spot.clip.src) {
          if (!v.paused) v.pause();
        }
      }

      // Sound items follow the playhead, re-seeked only when they drift, so they never stutter.
      for (const s of soundsOf(cur)) {
        const a = sounds.current.get(s.id);
        if (!a) continue;
        if (!playRef.current || !spot || t < s.at || t >= s.at + s.dur) {
          if (!a.paused) a.pause();
          continue;
        }
        const want = s.in + (t - s.at);
        if (Math.abs(a.currentTime - want) > 0.25) a.currentTime = want;
        a.volume = s.volume;
        if (a.paused) void a.play().catch(() => {});
      }

      if (!spot) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (playRef.current) setPlaying(false);
        return;
      }

      const v = gap ? null : (pool.current.get(spot.clip.src) ?? null);
      if (gap) {
        // A gap has no video to keep time, so the frame clock carries the playhead across it.
        const after = spots[spot.index + 1];
        const nv = after && !isSlug(after.clip) ? pool.current.get(after.clip.src) : undefined;
        if (nv && Math.abs(nv.currentTime - after.clip.in) > 0.05) nv.currentTime = after.clip.in;
        if (playRef.current) setPlayhead(Math.min(spot.end, t + tick), true);
      } else {
        if (!v || !v.videoWidth) return;
        const rate = spot.clip.speed ?? 1;
        const wanted = spot.clip.in + (t - spot.start) * rate;

        if (playRef.current) {
          v.playbackRate = rate;
          if (v.paused) void v.play().catch(() => setPlaying(false));
          // A cut is a seek: at the out-point, jump rather than play through.
          if (v.currentTime >= spot.clip.out - 0.03) {
            const next = spots[spot.index + 1];
            if (!next) {
              setPlaying(false);
              setPlayhead(spot.end, true);
            } else {
              const nv = isSlug(next.clip) ? undefined : pool.current.get(next.clip.src);
              if (nv) nv.currentTime = next.clip.in;
              setPlayhead(next.start + 0.001, true);
            }
          } else {
            // The video element is the clock inside a clip, so audio and picture stay locked.
            setPlayhead(spot.start + (v.currentTime - spot.clip.in) / rate, true);
          }
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - wanted) > 0.05) v.currentTime = wanted;
        }
      }

      // The exporter draws every frame through this same function, so what
      // plays here is what gets written to the file.
      const { crop: liveCrop, cropping: framing } = frameRef.current;
      composeFrame(
        ctx,
        cur,
        t,
        // A gap draws no picture, but titles and fades still land on its black.
        v && v.videoWidth ? { source: v, width: v.videoWidth, height: v.videoHeight } : null,
        { width: canvas.width, height: canvas.height },
        framing ? FULL_FRAME : liveCrop,
      );
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pool, sounds, setPlayhead, setPlaying]);

  useEffect(() => {
    if (playing) return;
    for (const [, v] of pool.current) if (!v.paused) v.pause();
    for (const [, a] of sounds.current) if (!a.paused) a.pause();
  }, [playing, pool, sounds]);

  // Dragging updates a draft; only letting go writes a version. Otherwise a
  // single crop gesture would bury the history under a hundred entries.
  const commitCrop = useCallback(() => {
    setCropDraft((d) => {
      if (d) apply(setCrop(edl, d), "Crop");
      return null;
    });
  }, [apply, edl]);

  const PRESETS: Array<[string, number | null]> = [
    ["Full frame", null],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:5", 4 / 5],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Mid-grey mat. A black surround makes footage read brighter than it
          is, so the area immediately around the gate is neutral. */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-mat px-10 py-7">
        {/* Framing belongs to the picture, so its control lives over the mat
            rather than in a bar of its own. */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
          {isCropped(edl) && !cropping && (
            <Chip tone="leader">
              {out.width} × {out.height}
            </Chip>
          )}
          <Button
            onClick={() => setCropping(!cropping)}
            icon={<CropIcon />}
            className={`border border-edge bg-panel/90 backdrop-blur ${cropping ? "text-ink" : ""}`}
            title="Reframe the finished video"
          >
            Crop
          </Button>
        </div>
        <div
          className="relative max-h-full max-w-full overflow-hidden rounded-gate shadow-[0_4px_28px_rgba(0,0,0,.5)]"
          style={{ aspectRatio: `${view.width} / ${view.height}` }}
        >
          <canvas
            ref={canvasRef}
            width={Math.min(1600, view.width)}
            height={Math.round(Math.min(1600, view.width) * (view.height / view.width))}
            className="block h-full w-full"
          />
          {cropping && (
            <CropOverlay crop={live} onChange={setCropDraft} onCommit={commitCrop} />
          )}
          {zoomBeingEdited && (
            <FocusPoint
              x={zoomBeingEdited.x}
              y={zoomBeingEdited.y}
              scale={zoomBeingEdited.scale}
              crop={crop}
              onChange={(p) => setDraft(updateEffect(edl, zoomBeingEdited.id, p as never))}
              onCommit={() => commitDraft("Zoom focus")}
            />
          )}
        </div>
      </div>

      {cropping && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-edge bg-panel px-3 py-2">
          <span className="mr-1 text-[12px] text-ink-2">Reframe</span>
          {PRESETS.map(([label, aspect]) => {
            const active =
              aspect === null
                ? !isCropped(edl)
                : Math.abs(out.width / out.height - aspect) < 0.02 && isCropped(edl);
            return (
              <Button
                key={label}
                onClick={() => apply(setCropAspect(edl, aspect), aspect ? `Crop to ${label}` : "Full frame")}
                className={active ? "bg-raised text-ink" : ""}
              >
                {label}
              </Button>
            );
          })}
          <div className="ml-auto flex items-center gap-1.5">
            <Chip>{out.width} × {out.height}</Chip>
            <Button
              onClick={() => apply(resetCrop(edl), "Reset crop")}
              icon={<ResetIcon size={13} />}
              disabled={!isCropped(edl)}
              title="Put the framing back to the full frame"
            >
              Reset
            </Button>
            <Button variant="primary" size="md" onClick={() => setCropping(false)}>
              Done
            </Button>
          </div>
        </div>
      )}

    </div>
  );
}
