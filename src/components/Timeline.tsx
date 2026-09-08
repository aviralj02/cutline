"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, useEdl } from "@/lib/store";
import { duration, fmt, isFade, placed, tracksOf } from "@/lib/edl/query";
import {
  addEffect, addTrack, deleteClip, makeEffect, moveEffect, removeTrack,
  setSpeed, splitAt, trimClipEdge, trimEffect,
} from "@/lib/edl/ops";
import type { Effect, TrackKind } from "@/lib/edl/types";
import EffectInspector from "./EffectInspector";
import {
  AddIcon, AddMediaIcon, BackspaceIcon, Button, CloseIcon, FadeTrackIcon,
  FilmIcon, Kbd, Segmented, SpeedIcon, SplitIcon, TextTrackIcon, TrashIcon,
  ZoomTrackIcon,
} from "@/components/ui";

/**
 * Bars sit at a fixed pixel pitch rather than a fixed count, so a wide clip
 * gets more of them instead of fatter ones. At this pitch a bar is about
 * 3.5px, where a full round cap reads as softened rather than as a lozenge.
 */
const BAR_PITCH = 5;
const BAR_GAP = 1.5;

/** Tick intervals a viewer can read at a glance, coarsest last. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800] as const;
/** Room for "0:00.00" plus breathing space. */
const MIN_TICK_PX = 68;

/** The lane label column. Fixed, so every lane starts at the same time zero. */
const GUTTER = 118;

type DragKind = "move" | "start" | "end";
interface Drag {
  id: string;
  kind: DragKind;
  at: number;
  dur: number;
}

export default function Timeline() {
  const playhead = useStore((s) => s.playhead);
  const setPlayhead = useStore((s) => s.setPlayhead);
  const waveforms = useStore((s) => s.waveforms);
  const selected = useStore((s) => s.selectedClip);
  const selectedEffect = useStore((s) => s.selectedEffect);
  const select = useStore((s) => s.select);
  const selectEffect = useStore((s) => s.selectEffect);
  const apply = useStore((s) => s.apply);
  const media = useStore((s) => s.media);
  const setDraft = useStore((s) => s.setDraft);
  const commitDraft = useStore((s) => s.commitDraft);
  const addMedia = useStore((s) => s.addMedia);

  const edl = useEdl();
  const spots = useMemo(() => placed(edl), [edl]);
  const tracks = tracksOf(edl);
  const total = duration(edl);

  /**
   * Envelopes are drawn relative to each file's own peak, the way every audio
   * editor does it. Scaling by absolute amplitude means a normally recorded
   * voice — which peaks nowhere near full scale — draws as a flat smudge.
   */
  const gain = useMemo(() => {
    const g: Record<string, number> = {};
    for (const [id, w] of Object.entries(waveforms)) {
      let peak = 0;
      for (const v of w) if (v > peak) peak = v;
      // Below this the file is effectively silent, and amplifying it would
      // just magnify room tone into a waveform that is not there.
      g[id] = peak > 0.02 ? 1 / peak : 1;
    }
    return g;
  }, [waveforms]);

  const lanesRef = useRef<HTMLDivElement>(null);
  const [lanesW, setLanesW] = useState(0);
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setLanesW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const split = useCallback(
    () => apply(splitAt(edl, playhead), `Split at ${fmt(playhead)}`),
    [apply, edl, playhead],
  );
  const removeSelected = useCallback(() => {
    if (selected) apply(deleteClip(edl, selected), "Delete clip");
  }, [apply, edl, selected]);

  const selectedClip = edl.clips.find((c) => c.id === selected) ?? null;
  const speed = selectedClip?.speed ?? 1;
  const changeSpeed = (rate: number) => {
    if (!selectedClip) return;
    apply(setSpeed(edl, selectedClip.id, rate), rate === 1 ? "Normal speed" : `Speed ${rate}×`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        split();
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selected) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [split, removeSelected, selected]);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = lanesRef.current;
      if (!el || !total) return 0;
      const rect = el.getBoundingClientRect();
      return Math.max(0, Math.min(total, ((clientX - rect.left) / rect.width) * total));
    },
    [total],
  );

  const seekFromEvent = useCallback((clientX: number) => setPlayhead(timeAt(clientX)), [setPlayhead, timeAt]);

  /**
   * Scrubbing lives on the ruler and nowhere else.
   *
   * The track used to scrub as well, which worked while a clip was only ever
   * something you selected. Now that clips are dragged and trimmed, one
   * surface cannot mean both "move the playhead" and "edit this clip" — a
   * gesture would have to guess. The ruler is the one place where dragging
   * unambiguously means time.
   */
  const scrub = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      seekFromEvent(e.clientX);
      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        seekFromEvent(ev.clientX);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [seekFromEvent],
  );

  /** Dragging a clip's edge retimes it against its own source footage. */
  const startClipTrim = useCallback(
    (e: React.PointerEvent, clipId: string, edge: "start" | "end") => {
      if (e.button !== 0) return;
      e.stopPropagation();
      select(clipId);
      const sourceDur = media.find((m) => m.id === edl.clips.find((c) => c.id === clipId)?.src)?.duration;
      let live = edl;

      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        live = trimClipEdge(edl, clipId, edge, timeAt(ev.clientX), sourceDur);
        setDraft(live);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (live !== edl) commitDraft("Trim clip");
        else setDraft(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [commitDraft, edl, media, select, setDraft, timeAt],
  );

  /* ----- effect drag: move the whole item, or trim either edge ----------- */
  const [drag, setDrag] = useState<Drag | null>(null);

  const startDrag = useCallback(
    (e: React.PointerEvent, item: Effect, kind: DragKind) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      selectEffect(item.id);

      const grabbed = timeAt(e.clientX);
      const offset = grabbed - item.at;
      let live: Drag = { id: item.id, kind, at: item.at, dur: item.dur };
      setDrag(live);

      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        const t = timeAt(ev.clientX);
        if (kind === "move") {
          live = { ...live, at: Math.max(0, t - offset) };
        } else if (kind === "start") {
          const end = item.at + item.dur;
          const at = Math.max(0, Math.min(end - 0.08, t));
          live = { ...live, at, dur: end - at };
        } else {
          live = { ...live, dur: Math.max(0.08, t - item.at) };
        }
        setDrag(live);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        // One version per gesture, not one per pixel.
        setDrag(null);
        if (kind === "move") {
          if (Math.abs(live.at - item.at) > 1e-4) apply(moveEffect(edl, item.id, live.at), "Move effect");
        } else if (kind === "start") {
          if (Math.abs(live.at - item.at) > 1e-4) apply(trimEffect(edl, item.id, "start", live.at), "Trim effect");
        } else if (Math.abs(live.dur - item.dur) > 1e-4) {
          apply(trimEffect(edl, item.id, "end", item.at + live.dur), "Trim effect");
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [apply, edl, selectEffect, timeAt],
  );

  const addLane = (kind: TrackKind) => apply(addTrack(edl, kind), `Add ${kind} track`);

  /** New effects land at the playhead, where the user is already looking. */
  const addHere = (trackId: string, kind: TrackKind) => {
    const at = Math.min(playhead, Math.max(0, total - 1));
    const item = makeEffect(kind, at);
    apply(addEffect(edl, trackId, item), `Add ${kind}`);
    // Select it, so the inspector opens on what you just made instead of
    // leaving you to hunt for it.
    selectEffect(item.id);
  };

  const pct = (t: number) => (total ? (t / total) * 100 : 0);

  const step = useMemo(() => {
    if (!total || !lanesW) return TICK_STEPS[2];
    return (
      TICK_STEPS.find((s) => (s / total) * lanesW >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1]
    );
  }, [total, lanesW]);
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);

  const laneHead = (
    icon: React.ReactNode,
    name: string,
    onRemove?: () => void,
    onAdd?: () => void,
    onAddMedia?: () => void,
  ) => (
    <div className="flex h-full items-center gap-1.5 pr-2" style={{ width: GUTTER }}>
      <span className="text-ink-3">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">{name}</span>
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Add to ${name}`}
          title={`Add to ${name} at the playhead`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-ink-3 transition-colors hover:bg-white/[.08] hover:text-ink"
        >
          <AddIcon size={12} />
        </button>
      )}
      {onAddMedia && (
        <label
          title="Add another video to the end of this track"
          className="grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-3 transition-colors hover:bg-white/[.08] hover:text-ink focus-within:bg-white/[.08] focus-within:text-ink"
        >
          <input
            type="file"
            accept="video/*"
            aria-label="Add another video"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void addMedia(f);
              e.target.value = "";
            }}
          />
          <AddMediaIcon size={12} />
        </label>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name} track`}
          title={`Remove the ${name} track`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-ink-3 transition-colors hover:bg-grease/15 hover:text-grease"
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div className="overflow-hidden rounded-panel border border-edge bg-panel shadow-[0_1px_3px_rgba(0,0,0,.35)]">
      <div className="flex h-12 items-center gap-1 border-b border-edge px-3.5">
        <h2 className="text-[13px] font-semibold tracking-[-.01em] text-ink">Timeline</h2>
        <span className="ml-2 text-[12px] text-ink-3">
          {edl.clips.length} clip{edl.clips.length === 1 ? "" : "s"}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {selectedClip && (
            <div className="mr-1 flex items-center gap-1.5">
              <SpeedIcon size={13} className="text-ink-3" />
              <Segmented
                label="Clip speed"
                options={[0.5, 1, 1.5, 2] as const}
                value={([0.5, 1, 1.5, 2] as const).find((r) => Math.abs(speed - r) < 0.001) ?? 1}
                onChange={changeSpeed}
                format={(r) => `${r}×`}
                title={(r) => (r === 1 ? "Play this clip at normal speed" : `Play this clip at ${r} times speed`)}
              />
            </div>
          )}
          <Button onClick={split} icon={<SplitIcon />} disabled={!total} title="Split the clip at the playhead (S)">
            Split <Kbd>S</Kbd>
          </Button>
          <Button
            variant="danger"
            onClick={removeSelected}
            icon={<TrashIcon />}
            disabled={!selected}
            title="Delete the selected clip and close the gap (Backspace)"
          >
            Delete <Kbd><BackspaceIcon size={11} /></Kbd>
          </Button>
        </div>
      </div>

      {!total ? (
        <div className="m-3.5 grid h-24 place-items-center rounded-gate border border-dashed border-edge text-[12px] text-ink-3">
          Nothing on the timeline
        </div>
      ) : (
        <>
          <div className="px-3.5 pb-2.5 pt-3">
            {/* The ruler is also the scrub bar — the only surface where a
                drag means time. Everything below it edits. */}
            <div className="flex">
              <div className="flex shrink-0 items-end pb-1 pr-2" style={{ width: GUTTER }}>
                <span className="text-[10px] text-ink-3">Drag to scrub</span>
              </div>
              <div
                onPointerDown={scrub}
                role="slider"
                aria-label="Playhead"
                aria-valuemin={0}
                aria-valuemax={Math.round(total * 100) / 100}
                aria-valuenow={Math.round(playhead * 100) / 100}
                tabIndex={0}
                className="group relative mb-1.5 h-6 flex-1 cursor-ew-resize touch-none select-none rounded-sm bg-white/4 ring-1 ring-edge transition-colors hover:bg-white/[.07]"
              >
                {ticks.map((t, i) => {
                  const first = i === 0;
                  const last = i === ticks.length - 1 && pct(t) > 92;
                  return (
                    <span key={t} className="pointer-events-none">
                      <span
                        className="absolute bottom-0 w-px bg-edge"
                        style={{ left: `${pct(t)}%`, height: first || last ? 6 : 4 }}
                      />
                      <span
                        className={`tnum absolute top-0.75 font-mono text-[10px] text-ink ${
                          first ? "ml-1" : last ? "-translate-x-full -ml-1" : "-translate-x-1/2"
                        }`}
                        style={{ left: `${pct(t)}%` }}
                      >
                        {fmt(t)}
                      </span>
                    </span>
                  );
                })}
                {/* The grabbable head sits in the ruler; the line below it
                    crosses the lanes but is not itself a target. */}
                <span
                  className="pointer-events-none absolute -bottom-1 z-20 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-ink shadow-[0_1px_3px_rgba(0,0,0,.6)]"
                  style={{ left: `${pct(playhead)}%` }}
                />
              </div>
            </div>

            <div className="relative flex flex-col gap-1.5">
              {/* Video lane */}
              <div className="flex">
                {laneHead(<FilmIcon size={13} />, "Video", undefined, undefined, () => {})}
                <div
                  ref={lanesRef}
                  className="relative h-20 flex-1 touch-none overflow-hidden rounded-gate bg-[#0d0d0d] ring-1 ring-edge"
                >
                  {spots.map((p) => {
                    const wave = waveforms[p.clip.src] ?? [];
                    const mediaDur = media.find((m) => m.id === p.clip.src)?.duration || p.clip.out;
                    const isSel = selected === p.clip.id;
                    const clipW = total ? ((p.end - p.start) / total) * lanesW : 0;
                    const bars = Math.max(3, Math.min(600, Math.round(clipW / BAR_PITCH)));
                    return (
                      <div
                        key={p.clip.id}
                        data-clip={p.clip.id}
                        onPointerDown={(e) => {
                          if (e.button === 0) select(p.clip.id);
                        }}
                        title={`Clip ${p.index + 1} — timeline ${fmt(p.start)} to ${fmt(p.end)}, from source ${fmt(p.clip.in)} to ${fmt(p.clip.out)}. Drag either edge to trim.`}
                        className={`group absolute inset-y-0.5 cursor-pointer overflow-hidden rounded-sm transition-[box-shadow,background-color] ${
                          p.index % 2 ? "bg-[#242424]" : "bg-[#1f1f1f]"
                        }`}
                        style={{
                          left: `calc(${pct(p.start)}% + 2px)`,
                          width: `calc(${pct(p.end - p.start)}% - 4px)`,
                          boxShadow: isSel
                            ? "inset 0 0 0 1.5px var(--color-leader)"
                            : "inset 0 0 0 1px #2e2e2e",
                        }}
                      >
                        <div className="pointer-events-none absolute inset-0">
                          {wave.length > 0 &&
                            Array.from({ length: bars }, (_, i) => {
                              const frac = i / bars;
                              const srcT = p.clip.in + (p.clip.out - p.clip.in) * frac;
                              const idx = Math.floor((srcT / (mediaDur || 1)) * wave.length);
                              const amp = wave[Math.min(wave.length - 1, Math.max(0, idx))] ?? 0;
                              const norm = Math.min(1, amp * (gain[p.clip.src] ?? 1));
                              return (
                                <span
                                  key={i}
                                  data-bar=""
                                  className={`absolute top-1/2 -translate-y-1/2 rounded-full ${
                                    isSel ? "bg-[#c9c9c9]/85" : "bg-[#8f8f8f]/60"
                                  }`}
                                  style={{
                                    left: `${frac * 100}%`,
                                    width: `calc(${100 / bars}% - ${BAR_GAP}px)`,
                                    height: `${norm * 74}%`,
                                    minHeight: "3px",
                                  }}
                                />
                              );
                            })}
                        </div>
                        {(["start", "end"] as const).map((edge) => (
                          <span
                            key={edge}
                            role="slider"
                            tabIndex={0}
                            aria-label={`Trim ${edge} of clip ${p.index + 1}`}
                            aria-valuemin={0}
                            aria-valuemax={Math.round(total * 100) / 100}
                            aria-valuenow={Math.round((edge === "start" ? p.start : p.end) * 100) / 100}
                            onPointerDown={(e) => startClipTrim(e, p.clip.id, edge)}
                            onKeyDown={(e) => {
                              const d = e.key === "ArrowLeft" ? -1 / edl.fps : e.key === "ArrowRight" ? 1 / edl.fps : 0;
                              if (!d) return;
                              e.preventDefault();
                              const at = (edge === "start" ? p.start : p.end) + d;
                              const src = media.find((m) => m.id === p.clip.src)?.duration;
                              apply(trimClipEdge(edl, p.clip.id, edge, at, src), "Trim clip");
                            }}
                            className={`absolute inset-y-0 z-10 w-2.5 cursor-ew-resize touch-none transition-colors hover:bg-white/25 focus-visible:bg-white/35 ${
                              edge === "start" ? "left-0" : "right-0"
                            }`}
                          >
                            <span
                              className={`pointer-events-none absolute inset-y-2 w-[2px] rounded-full bg-white/50 opacity-0 transition-opacity group-hover:opacity-100 ${
                                edge === "start" ? "left-[3px]" : "right-[3px]"
                              }`}
                            />
                          </span>
                        ))}
                        <span className="tnum pointer-events-none absolute left-2 top-1 flex items-center gap-1.5 font-mono text-[10px] text-ink-3 [text-shadow:0_1px_3px_rgba(0,0,0,.9)]">
                          {p.index + 1}
                          {p.clip.speed && p.clip.speed !== 1 && (
                            <span className="rounded-[3px] bg-leader/20 px-1 text-leader">{p.clip.speed}×</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Text lane, shown only when there is text to show. */}
              {edl.text.length > 0 && (
                <div className="flex">
                  {laneHead(<TextTrackIcon size={13} />, "Text")}
                  <div className="relative h-7 flex-1 overflow-hidden rounded-ctl bg-[#0d0d0d] ring-1 ring-edge">
                    {edl.text.map((t) => (
                      <div
                        key={t.id}
                        title={t.content}
                        className="absolute inset-y-1 flex items-center overflow-hidden rounded-[4px] bg-white/12 px-1.5 text-[10px] text-ink-2 ring-1 ring-white/15"
                        style={{ left: `${pct(t.at)}%`, width: `${Math.max(1, pct(t.dur))}%` }}
                      >
                        <span className="truncate">{t.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Effect lanes */}
              {tracks.map((track) => (
                <div key={track.id} className="flex">
                  {laneHead(
                    track.kind === "fade" ? <FadeTrackIcon size={13} /> : <ZoomTrackIcon size={13} />,
                    track.name,
                    () => apply(removeTrack(edl, track.id), `Remove ${track.name} track`),
                    () => addHere(track.id, track.kind),
                  )}
                  <div
                    onDoubleClick={() => addHere(track.id, track.kind)}
                    title={`Double-click to add a ${track.kind} at the playhead`}
                    className="relative h-9 flex-1 touch-none overflow-hidden rounded-ctl bg-[#0d0d0d] ring-1 ring-edge"
                  >
                    {track.items.map((item) => {
                      const live = drag?.id === item.id ? drag : item;
                      const isSel = selectedEffect === item.id;
                      return (
                        <div
                          key={item.id}
                          data-effect={item.id}
                          onPointerDown={(e) => startDrag(e, item, "move")}
                          className={`group absolute inset-y-1 cursor-grab touch-none overflow-hidden rounded-[6px] bg-[#333] active:cursor-grabbing ${
                            isSel ? "ring-[1.5px] ring-leader" : "ring-1 ring-white/15"
                          }`}
                          style={{ left: `${pct(live.at)}%`, width: `${Math.max(0.6, pct(live.dur))}%` }}
                        >
                          {/* The ramp is painted over a surface rather than
                              straight onto the lane, so a fade to black is
                              still visible on a black lane. */}
                          <span
                            className="pointer-events-none absolute inset-0"
                            style={{
                              background: isFade(item)
                                ? item.mode === "in"
                                  ? `linear-gradient(90deg, ${item.color}, transparent)`
                                  : item.mode === "out"
                                    ? `linear-gradient(90deg, transparent, ${item.color})`
                                    : `linear-gradient(90deg, transparent, ${item.color} 50%, transparent)`
                                : "linear-gradient(90deg, rgba(224,169,46,.12), rgba(224,169,46,.42), rgba(224,169,46,.12))",
                            }}
                          />
                          <span className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-3 text-[10px] font-medium text-ink [text-shadow:0_1px_3px_rgba(0,0,0,.95)]">
                            {isFade(item)
                              ? item.mode === "in" ? "Fade in" : item.mode === "out" ? "Fade out" : "Dip"
                              : `${item.scale.toFixed(1)}×`}
                          </span>

                          {/* Trim handles. Wide enough to hit, narrow enough
                              not to eat the body drag on a short effect. */}
                          {(["start", "end"] as const).map((edge) => (
                            <span
                              key={edge}
                              role="slider"
                              tabIndex={0}
                              aria-label={`Trim ${edge} of ${isFade(item) ? "fade" : "zoom"}`}
                              aria-valuenow={Math.round((edge === "start" ? live.at : live.at + live.dur) * 100) / 100}
                              aria-valuemin={0}
                              aria-valuemax={Math.round(total * 100) / 100}
                              onPointerDown={(e) => startDrag(e, item, edge)}
                              onKeyDown={(e) => {
                                const d = e.key === "ArrowLeft" ? -1 / edl.fps : e.key === "ArrowRight" ? 1 / edl.fps : 0;
                                if (!d) return;
                                e.preventDefault();
                                e.stopPropagation();
                                const at = edge === "start" ? item.at + d : item.at + item.dur + d;
                                apply(trimEffect(edl, item.id, edge, at), "Trim effect");
                              }}
                              className={`absolute inset-y-0 w-2 cursor-ew-resize touch-none rounded-[3px] bg-white/0 transition-colors hover:bg-white/25 focus-visible:bg-white/35 ${
                                edge === "start" ? "left-0" : "right-0"
                              }`}
                            >
                              <span
                                className={`pointer-events-none absolute inset-y-1.5 w-[2px] rounded-full bg-white/45 opacity-0 transition-opacity group-hover:opacity-100 ${
                                  edge === "start" ? "left-[3px]" : "right-[3px]"
                                }`}
                              />
                            </span>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* One playhead, crossing every lane. */}
              <div
                className="pointer-events-none absolute inset-y-0 z-10"
                style={{ left: GUTTER, right: 0 }}
              >
                <div className="absolute inset-y-0 w-px bg-ink/80" style={{ left: `${pct(playhead)}%` }} />
              </div>
            </div>

            <div className="mt-2.5 flex items-center gap-1.5" style={{ paddingLeft: GUTTER }}>
              {/* One lane per kind, so the control disappears once it exists
                  rather than sitting there doing nothing. */}
              {!tracks.some((t) => t.kind === "fade") && (
                <Button icon={<FadeTrackIcon size={13} />} onClick={() => addLane("fade")}>
                  Add fade track
                </Button>
              )}
              {!tracks.some((t) => t.kind === "zoom") && (
                <Button icon={<ZoomTrackIcon size={13} />} onClick={() => addLane("zoom")}>
                  Add zoom track
                </Button>
              )}
              <span className="ml-auto text-[11px] text-ink-3">
                {tracks.length ? "Double-click a lane to add at the playhead" : "Drag to scrub"}
              </span>
            </div>
          </div>

          <EffectInspector />
        </>
      )}
    </div>
  );
}
