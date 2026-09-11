"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, useEdl } from "@/lib/store";
import { clipCount, clipNumber, dropSlot, duration, fmt, isFade, isSlug, placed, tracksOf } from "@/lib/edl/query";
import {
  addEffect, addTrack, deleteClip, makeEffect, moveClip, moveEffect, removeEffect,
  removeTrack, setSpeed, splitAt, swapClips, trackOfEffect, trimClipEdge, trimEffect,
} from "@/lib/edl/ops";
import type { Effect, TrackKind } from "@/lib/edl/types";
import EffectInspector from "./EffectInspector";
import {
  AddIcon, AddMediaIcon, BackspaceIcon, Button, CloseIcon, FadeTrackIcon,
  FilmIcon, IconButton, Kbd, ScaleInIcon, ScaleOutIcon, Segmented, SpeedIcon,
  SplitIcon, TextTrackIcon, TrashIcon, ZoomTrackIcon,
} from "@/components/ui";

/**
 * Bars sit at a fixed pixel pitch rather than a fixed count, so a wide clip
 * gets more of them instead of fatter ones. At this pitch a bar is about
 * 3.5px, where a full round cap reads as softened rather than as a lozenge.
 */
const BAR_PITCH = 5;
const BAR_GAP = 1.5;
/**
 * How far past the viewport waveform bars are drawn, and the step the window
 * is quantised to. Magnified, a clip is tens of thousands of pixels wide and
 * nearly all of it is off screen; quantising means scrolling redraws the bars
 * every 400px rather than on every frame.
 */
const BAR_WINDOW = 400;

/** Tick intervals a viewer can read at a glance, coarsest last. */
const TICK_STEPS = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
] as const;

/**
 * Magnification, as how many viewport widths the timeline is drawn across.
 * Expressing it this way rather than in pixels per second means "1×" always
 * means "the whole edit at once", whatever the window or the footage.
 */
const SCALE_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32] as const;
/**
 * Minimum pitch between ticks. A label is ~42px, and the first one is
 * left-aligned rather than centred — it spends half a label of the first gap
 * on itself — so the floor has to cover 1.5 labels plus air, not one.
 * At 68 the opening pair closed to 2.7px on a held extent.
 */
const MIN_TICK_PX = 80;

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
  const playing = useStore((s) => s.playing);
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
  const viewRef = useRef<HTMLDivElement | null>(null);
  const [viewW, setViewW] = useState(0);
  /**
   * Measured on whichever scroller is mounted, not on the first one. An empty
   * track swaps the scroller for a placeholder, so deleting every clip
   * unmounts it; an observer attached once on mount went on watching the
   * detached element, read its width as 0, and the footage came back from an
   * undo or a restore drawn 120px wide.
   */
  const attachView = useCallback((el: HTMLDivElement) => {
    viewRef.current = el;
    const read = () => setViewW(Math.max(0, el.clientWidth - GUTTER));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      ro.disconnect();
      viewRef.current = null;
    };
  }, []);

  /**
   * The visible time extent, which is not the same thing as the duration.
   *
   * A trim that shortens the edit must not rescale the timeline under the
   * hand doing the trimming: the clip would keep its width as its content
   * shrank, the pointer would slide off the handle it is holding, and there
   * would be nowhere left to drag back out to. So the extent is held at the
   * longest the edit has been. It grows with the material and is released
   * only by Fit, which is the one control whose job is to reframe.
   */
  const [held, setHeld] = useState(0);
  useEffect(() => {
    setHeld((h) => (total > h ? total : h));
  }, [total]);
  const span = Math.max(total, held);

  const [scaleIdx, setScaleIdx] = useState(0);
  const scale = SCALE_STEPS[scaleIdx];
  /** Pixel width of the time area. Beyond the viewport it scrolls. */
  const contentW = Math.max(120, viewW * scale);
  const fitted = scaleIdx === 0 && span <= total + 0.001;

  // Fit reframes to the edit as it stands now. It records that length rather
  // than clearing the hold: zeroing it would mean the next shrink is measured
  // against the already-shrinking draft, and the timeline would creep by a
  // percent on every trim.
  const fit = useCallback(() => {
    setScaleIdx(0);
    setHeld(total);
  }, [total]);

  /**
   * How far the time area is scrolled. macOS draws overlay scrollbars, which
   * occupy no layout and vanish at rest — measured here as a scrollbar 0px
   * tall — so a zoomed timeline gave no sign at all that it continued past
   * the right edge. The position bar below the lanes is that sign, and it
   * needs to know where the view is.
   */
  const [scrollX, setScrollX] = useState(0);
  const maxScroll = Math.max(0, contentW - viewW);
  useEffect(() => {
    const el = viewRef.current;
    if (el) setScrollX(Math.min(el.scrollLeft, maxScroll));
  }, [maxScroll]);

  const scrollTo = useCallback(
    (left: number) => {
      const el = viewRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, Math.min(maxScroll, left));
      setScrollX(el.scrollLeft);
    },
    [maxScroll],
  );

  /** Drag the position bar to move the view, the way its scrollbar would. */
  const dragView = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !viewW) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const to = (clientX: number) =>
        scrollTo(((clientX - rect.left) / rect.width) * contentW - viewW / 2);
      to(e.clientX);
      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        to(ev.clientX);
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
    [contentW, scrollTo, viewW],
  );

  const split = useCallback(
    () => apply(splitAt(edl, playhead), `Split at ${fmt(playhead)}`),
    [apply, edl, playhead],
  );
  // Delete means "the selection", whichever kind it is. Selection is
  // exclusive, so there is never a question of which one goes.
  const removeSelected = useCallback(() => {
    if (selected) {
      const target = edl.clips.find((c) => c.id === selected);
      apply(deleteClip(edl, selected), target && isSlug(target) ? "Close gap" : "Delete clip");
      return;
    }
    const track = selectedEffect ? trackOfEffect(edl, selectedEffect) : null;
    if (!selectedEffect || !track) return;
    selectEffect(null);
    apply(removeEffect(edl, selectedEffect), `Remove ${track.name.toLowerCase()}`);
  }, [apply, edl, selected, selectedEffect, selectEffect]);

  const selectedClip = edl.clips.find((c) => c.id === selected && !isSlug(c)) ?? null;
  const speed = selectedClip?.speed ?? 1;
  const changeSpeed = (rate: number) => {
    if (!selectedClip) return;
    apply(setSpeed(edl, selectedClip.id, rate), rate === 1 ? "Normal speed" : `Speed ${rate}×`);
  };

  /**
   * The shortcut handler is registered once and reads current values through
   * this ref.
   *
   * Re-registering it on every edit looked harmless and silently ate every
   * arrow key: `Transport` owns a window keydown listener too and is mounted
   * first, so it runs first, moves the playhead, and React flushes that
   * synchronously — which re-runs this effect and removes the listener *while
   * the same event is still being dispatched*. A listener removed mid-dispatch
   * is never called, so the key reached the transport and stopped there.
   */
  const keys = useRef({ split, removeSelected, selected, selectedEffect, apply, edl });
  useEffect(() => {
    keys.current = { split, removeSelected, selected, selectedEffect, apply, edl };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { split, removeSelected, selected, selectedEffect, apply, edl } = keys.current;
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        split();
      }
      if ((e.key === "Backspace" || e.key === "Delete") && (selected || selectedEffect)) {
        e.preventDefault();
        removeSelected();
      }
      // Reordering by keyboard works on the selection rather than on a focused
      // clip: the trim handles inside a clip are already sliders, and a button
      // wrapping a slider is not a thing a screen reader can make sense of.
      if (e.altKey && selected && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const from = edl.clips.findIndex((c) => c.id === selected);
        if (from < 0 || isSlug(edl.clips[from])) return;
        // Swap with the nearest clip that way; a gap between them stays put.
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        let to = from + dir;
        while (edl.clips[to] && isSlug(edl.clips[to])) to += dir;
        if (to < 0 || to >= edl.clips.length) return;
        // Alt+Arrow is Back and Forward in some browsers.
        e.preventDefault();
        const next = swapClips(edl, selected, edl.clips[to].id);
        apply(next, `Move clip ${clipNumber(edl, selected)} to position ${clipNumber(next, selected)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Pointer position to timeline time. It maps against the drawn extent, so
   * the empty stretch past the end of the edit is addressable — that is what
   * a trim handle is dragged back out into.
   */
  const timeAt = useCallback(
    (clientX: number) => {
      const el = lanesRef.current;
      if (!el || !span) return 0;
      const rect = el.getBoundingClientRect();
      return Math.max(0, Math.min(span, ((clientX - rect.left) / rect.width) * span));
    },
    [span],
  );

  // The playhead has nowhere to be past the last frame, so scrubbing stops
  // at the duration even though the ruler continues.
  const seekFromEvent = useCallback(
    (clientX: number) => setPlayhead(Math.min(total, timeAt(clientX))),
    [setPlayhead, timeAt, total],
  );

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

  /** The clip currently being carried, so it can be drawn as lifted. */
  const [carrying, setCarrying] = useState<string | null>(null);

  /**
   * Dragging a clip's body reorders it.
   *
   * The track is contiguous by construction — no clip stores a position, it is
   * a prefix sum — so "move" here can only mean "change places". The clip snaps
   * into whichever slot the pointer is over rather than following the cursor
   * freely: a free-floating clip would imply the track can hold it anywhere,
   * and it cannot.
   *
   * The target slot is computed against the layout of the *other* clips, which
   * does not change as the preview does. Measuring against the preview instead
   * makes the two chase each other and the order flickers.
   */
  const startClipDrag = useCallback(
    (e: React.PointerEvent, spot: { clip: { id: string }; start: number; end: number }) => {
      if (e.button !== 0) return;
      select(spot.clip.id);
      if (clipCount(edl) < 2) return;

      const home = edl.clips.findIndex((c) => c.id === spot.clip.id);
      const grabbedAt = timeAt(e.clientX) - spot.start;
      const dur = spot.end - spot.start;
      const fromX = e.clientX;
      let target = home;
      let moved = false;

      const move = (ev: PointerEvent) => {
        ev.preventDefault();
        // A click that wanders a pixel is still a click, not a drag.
        if (!moved && Math.abs(ev.clientX - fromX) < 4) return;
        if (!moved) setCarrying(spot.clip.id);
        moved = true;

        const idx = dropSlot(edl, spot.clip.id, timeAt(ev.clientX) - grabbedAt + dur / 2);
        if (idx === target) return;
        target = idx;
        setDraft(idx === home ? null : moveClip(edl, spot.clip.id, idx));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        setCarrying(null);
        if (moved && target !== home) {
          const id = spot.clip.id;
          commitDraft(`Move clip ${clipNumber(edl, id)} to position ${clipNumber(moveClip(edl, id, target), id)}`);
        }
        else setDraft(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [commitDraft, edl, select, setDraft, timeAt],
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

  const pct = (t: number) => (span ? (t / span) * 100 : 0);

  const step = useMemo(() => {
    if (!span || !contentW) return TICK_STEPS[3];
    return (
      TICK_STEPS.find((s) => (s / span) * contentW >= MIN_TICK_PX) ??
      TICK_STEPS[TICK_STEPS.length - 1]
    );
  }, [span, contentW]);
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);

  /**
   * Keep the playhead on screen while it moves on its own. Only during
   * playback: scrolling to follow a pointer would move the ruler under the
   * pointer that is driving it, and the two would chase each other.
   */
  useEffect(() => {
    const el = viewRef.current;
    if (!el || !playing || !span) return;
    const x = GUTTER + (playhead / span) * contentW;
    const margin = 32;
    // Jump by the screenful rather than sliding: landing the playhead near the
    // left edge gives a full view of what is coming, and it writes scrollLeft
    // once per screen instead of once per frame.
    if (x < el.scrollLeft + GUTTER + margin || x > el.scrollLeft + el.clientWidth - margin) {
      scrollTo(x - GUTTER - margin);
    }
  }, [playhead, playing, span, contentW, scrollTo]);

  const laneHead = (
    icon: React.ReactNode,
    name: string,
    onRemove?: () => void,
    onAdd?: () => void,
    onAddMedia?: () => void,
  ) => (
    // `self-stretch`, not `h-full`: a percentage height against an auto-height
    // flex row collapses to the label's own 20px, which stayed invisible until
    // the lane started scrolling underneath it.
    <div
      className="sticky left-0 z-20 flex shrink-0 items-center gap-1.5 self-stretch bg-panel pr-2"
      style={{ width: GUTTER }}
    >
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
    // Nothing here is text to copy; every surface is a drag target, and a
    // sweep that starts on a label painted the whole card as a selection.
    <div className="select-none overflow-hidden rounded-panel border border-edge bg-panel shadow-[0_1px_3px_rgba(0,0,0,.35)]">
      <div className="flex h-12 items-center gap-1 border-b border-edge px-3.5">
        <h2 className="text-[13px] font-semibold tracking-[-.01em] text-ink">Timeline</h2>
        <span className="ml-2 text-[12px] text-ink-3">
          {clipCount(edl)} clip{clipCount(edl) === 1 ? "" : "s"}
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
            disabled={!selected && !selectedEffect}
            title="Delete the selected clip or effect (Backspace)"
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
            {/* One scroller for the ruler and every lane, so time stays in
                register down the stack. The label column is sticky rather
                than outside it — a second element scrolled in sympathy
                drifts by a pixel and the drift is visible on a hairline. */}
            <div
              ref={attachView}
              onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
              className="overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <div className="relative" style={{ width: GUTTER + contentW }}>
                {/* The ruler is also the scrub bar — the only surface where a
                    drag means time. Everything below it edits. */}
                <div className="flex">
                  <div
                    className="sticky left-0 z-30 flex shrink-0 items-end self-stretch bg-panel pb-1 pr-2"
                    style={{ width: GUTTER }}
                  >
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
                    style={{ width: contentW }}
                    className="group relative mb-1.5 h-6 shrink-0 cursor-ew-resize touch-none select-none rounded-sm bg-white/4 ring-1 ring-edge transition-colors hover:bg-white/[.07]"
                  >
                    {/* Past the last frame the ruler still measures, but there is
                        nothing there to measure — so it reads as inactive. */}
                    {span > total + 0.001 && (
                      <span
                        className="pointer-events-none absolute inset-y-0 right-0 rounded-r-sm bg-shell/70"
                        style={{ left: `${pct(total)}%` }}
                      />
                    )}
                    {ticks.map((t, i) => {
                      const first = i === 0;
                      const last = i === ticks.length - 1 && pct(t) > 92;
                      // A label cut by either edge of the view reads as a
                      // different number — clipped at its centre "0:05.00"
                      // says ".00", and clipped at the right it says "0:0" —
                      // so the mark stays and the number waits until it fits.
                      // The test is on the label's own box, which depends on
                      // how it is aligned: the first sits to the right of its
                      // tick, the last to the left, the rest astride it.
                      const xPx = (pct(t) / 100) * contentW;
                      const labelLeft = first ? xPx : last ? xPx - 46 : xPx - 21;
                      const legible =
                        labelLeft >= scrollX - 1 && labelLeft + 42 <= scrollX + viewW + 1;
                      return (
                        <span key={t} className="pointer-events-none">
                          <span
                            className="absolute bottom-0 w-px bg-edge"
                            style={{ left: `${pct(t)}%`, height: first || last ? 6 : 4 }}
                          />
                          {legible && (
                            <span
                              className={`tnum absolute top-0.75 font-mono text-[10px] text-ink ${
                                first ? "ml-1" : last ? "-translate-x-full -ml-1" : "-translate-x-1/2"
                              }`}
                              style={{ left: `${pct(t)}%` }}
                            >
                              {fmt(t)}
                            </span>
                          )}
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
                      style={{ width: contentW }}
                      className="relative h-20 shrink-0 touch-none overflow-hidden rounded-gate bg-[#0d0d0d] ring-1 ring-edge"
                    >
                      {spots.map((p) => {
                        if (isSlug(p.clip)) {
                          const isSel = selected === p.clip.id;
                          const secs = (p.end - p.start).toFixed(1);
                          return (
                            <button
                              key={p.clip.id}
                              type="button"
                              data-gap={p.clip.id}
                              aria-label={`Gap of ${secs} seconds`}
                              title="Plays as black. Select it and press Backspace to close it."
                              onPointerDown={(e) => {
                                if (e.button !== 0) return;
                                e.stopPropagation();
                                select(p.clip.id);
                              }}
                              onClick={() => select(p.clip.id)}
                              className={`absolute inset-y-0.5 grid place-items-center overflow-hidden rounded-sm border border-dashed transition-colors ${
                                isSel ? "border-leader bg-leader/[.06]" : "border-edge hover:bg-white/[.03]"
                              }`}
                              style={{
                                left: `calc(${pct(p.start)}% + 2px)`,
                                width: `calc(${pct(p.end - p.start)}% - 4px)`,
                              }}
                            >
                              <span className="tnum pointer-events-none truncate px-1 font-mono text-[10px] text-ink-3">
                                {secs}s gap
                              </span>
                            </button>
                          );
                        }
                        const number = clipNumber(edl, p.clip.id);
                        const wave = waveforms[p.clip.src] ?? [];
                        const mediaDur = media.find((m) => m.id === p.clip.src)?.duration || p.clip.out;
                        const isSel = selected === p.clip.id;
                        const clipL = span ? (p.start / span) * contentW : 0;
                        const clipW = span ? ((p.end - p.start) / span) * contentW : 0;
                        // Bars cover the visible slice at full density rather than
                        // the whole clip at a capped count. Capping the count on a
                        // 30,000px clip stretched every bar into a 50px block, and
                        // left the part actually on screen with a dozen of them.
                        const winL = Math.floor((scrollX - BAR_WINDOW) / BAR_WINDOW) * BAR_WINDOW;
                        const fromPx = Math.max(clipL, winL);
                        const toPx = Math.min(clipL + clipW, winL + viewW + BAR_WINDOW * 3);
                        const bars = Math.max(0, Math.min(1200, Math.round((toPx - fromPx) / BAR_PITCH)));
                        const barsFrom = fromPx - clipL;
                        return (
                          <div
                            key={p.clip.id}
                            data-clip={p.clip.id}
                            onPointerDown={(e) => startClipDrag(e, p)}
                            title={
                              `Clip ${number} — timeline ${fmt(p.start)} to ${fmt(p.end)}, ` +
                              `from source ${fmt(p.clip.in)} to ${fmt(p.clip.out)}. ` +
                              `Drag either edge to trim` +
                              (clipCount(edl) > 1
                                ? `, drag the body to reorder, or select it and press Alt with the arrow keys.`
                                : `.`)
                            }
                            className={`group absolute inset-y-0.5 overflow-hidden rounded-sm transition-[box-shadow,background-color] ${
                              number % 2 ? "bg-[#1f1f1f]" : "bg-[#242424]"
                            } ${
                              clipCount(edl) > 1
                                ? "cursor-grab active:cursor-grabbing"
                                : "cursor-pointer"
                            }`}
                            style={{
                              left: `calc(${pct(p.start)}% + 2px)`,
                              width: `calc(${pct(p.end - p.start)}% - 4px)`,
                              // Carrying a clip lifts it off the track. Without it
                              // the order changes under the cursor with nothing to
                              // say which clip is the one being carried.
                              boxShadow: carrying === p.clip.id
                                ? "inset 0 0 0 1.5px var(--color-leader), 0 6px 16px rgba(0,0,0,.6)"
                                : isSel
                                  ? "inset 0 0 0 1.5px var(--color-leader)"
                                  : "inset 0 0 0 1px #2e2e2e",
                            }}
                          >
                            <div className="pointer-events-none absolute inset-0">
                              {wave.length > 0 &&
                                Array.from({ length: bars }, (_, i) => {
                                  const frac = clipW ? (barsFrom + i * BAR_PITCH) / clipW : 0;
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
                                        // A real pixel width, so the pitch stays
                                        // the same however wide the clip is drawn.
                                        width: BAR_PITCH - BAR_GAP,
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
                                aria-label={`Trim ${edge} of clip ${number}`}
                                aria-valuemin={0}
                                aria-valuemax={Math.round(total * 100) / 100}
                                aria-valuenow={Math.round((edge === "start" ? p.start : p.end) * 100) / 100}
                                onPointerDown={(e) => startClipTrim(e, p.clip.id, edge)}
                                onKeyDown={(e) => {
                                  // Alt+Arrow reorders the clip, handled once at
                                  // the window. Trimming must not also fire.
                                  if (e.altKey) return;
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
                              {number}
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
                      <div
                        style={{ width: contentW }}
                        className="relative h-7 shrink-0 overflow-hidden rounded-ctl bg-[#0d0d0d] ring-1 ring-edge"
                      >
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
                        style={{ width: contentW }}
                        className="relative h-9 shrink-0 touch-none overflow-hidden rounded-ctl bg-[#0d0d0d] ring-1 ring-edge"
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
                    style={{ left: GUTTER, width: contentW }}
                  >
                    {/* Where the edit currently ends. Without it, a held extent
                        after a trim looks like a track that failed to draw. */}
                    {span > total + 0.001 && (
                      <div
                        className="absolute inset-y-0 border-l border-dashed border-ink-3/40"
                        style={{ left: `${pct(total)}%` }}
                      />
                    )}
                    <div className="absolute inset-y-0 w-px bg-ink/80" style={{ left: `${pct(playhead)}%` }} />
                  </div>
                </div>
              </div>
            </div>

            {/* The view's own position, drawn because the platform will not
                draw it: an overlay scrollbar is invisible at rest, so a
                timeline three screens wide looked like one screen that
                stopped. The bar is the width of the visible slice. */}
            {maxScroll > 1 && (
              <div style={{ paddingLeft: GUTTER }} className="mt-1.5">
                <div
                  onPointerDown={dragView}
                  role="slider"
                  aria-label="Timeline position"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(maxScroll)}
                  aria-valuenow={Math.round(scrollX)}
                  // Pixels of scroll mean nothing said aloud; the stretch of
                  // the edit on screen does.
                  aria-valuetext={`Showing ${fmt((scrollX / contentW) * span)} to ${fmt(
                    ((scrollX + viewW) / contentW) * span,
                  )} of ${fmt(span)}`}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                    if (!d) return;
                    e.preventDefault();
                    scrollTo(scrollX + d * viewW * 0.25);
                  }}
                  className="group relative h-2.5 cursor-grab touch-none rounded-full bg-white/[.05] active:cursor-grabbing"
                >
                  <span
                    className="absolute inset-y-0 rounded-full bg-white/20 transition-colors group-hover:bg-white/30"
                    style={{
                      left: `${(scrollX / contentW) * 100}%`,
                      width: `${Math.max(4, (viewW / contentW) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}

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
              {/* The newer affordance wins the hint: reordering is the one
                  that is not visible from the controls. */}
              {(clipCount(edl) > 1 || tracks.length > 0) && (
                <span className="ml-1 hidden text-[11px] text-ink-3 lg:inline">
                  {clipCount(edl) > 1
                    ? "Drag a clip to reorder it"
                    : "Double-click a lane to add at the playhead"}
                </span>
              )}

              {/* How the timeline is being looked at, kept apart from what it
                  is being made into. Nothing here is an edit, so nothing here
                  writes a version. */}
              <div className="ml-auto flex items-center gap-1">
                <IconButton
                  label="Show more time"
                  title="Show more time at once"
                  icon={<ScaleOutIcon />}
                  disabled={scaleIdx === 0}
                  onClick={() => setScaleIdx((i) => Math.max(0, i - 1))}
                />
                <span className="tnum w-[34px] text-center font-mono text-[11px] text-ink-2">
                  {scale}×
                </span>
                <IconButton
                  label="Show less time"
                  title="Spread the timeline out for finer trimming"
                  icon={<ScaleInIcon />}
                  disabled={scaleIdx === SCALE_STEPS.length - 1}
                  onClick={() => setScaleIdx((i) => Math.min(SCALE_STEPS.length - 1, i + 1))}
                />
                <Button
                  onClick={fit}
                  disabled={fitted}
                  title="Fit the whole edit to the width, releasing any room held open by a trim"
                >
                  Fit
                </Button>
              </div>
            </div>
          </div>

          <EffectInspector />
        </>
      )}
    </div>
  );
}
