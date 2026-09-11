import type { Clip, Crop, Edl, Sec } from "./types";

/**
 * Snap to a frame boundary. Every op runs its results through this so the same
 * edit always produces byte-identical JSON — which is what makes the version
 * history diffable instead of noisy with float drift.
 */
export const snap = (t: Sec, fps: number): Sec => Math.round(t * fps) / fps;

/** Duration this clip occupies on the timeline, after speed. */
export const clipDur = (c: Clip): Sec => Math.max(0, c.out - c.in) / (c.speed ?? 1);

/** A gap on the track is a clip of blank leader, a "slug": no file behind it, `in` 0, `out` its length. */
export const SLUG = "slug";
export const isSlug = (c: Clip): boolean => c.src === SLUG;
/** Clips with footage; gaps don't count. */
export const clipCount = (edl: Edl): number => edl.clips.filter((c) => !isSlug(c)).length;
/** A clip's number as the user sees it, counting footage only; 0 for a gap. */
export const clipNumber = (edl: Edl, id: string): number =>
  edl.clips.filter((c) => !isSlug(c)).findIndex((c) => c.id === id) + 1;

export interface Placed {
  clip: Clip;
  index: number;
  /** Timeline start. */
  start: Sec;
  /** Timeline end, exclusive. */
  end: Sec;
}

/** Resolve every clip's timeline position by prefix sum. */
export function placed(edl: Edl): Placed[] {
  const out: Placed[] = [];
  let t = 0;
  edl.clips.forEach((clip, index) => {
    const d = clipDur(clip);
    out.push({ clip, index, start: t, end: t + d });
    t += d;
  });
  return out;
}

export function dropSlot(edl: Edl, clipId: string, centre: Sec): number {
  const others = placed(edl).filter((p) => p.clip.id !== clipId);
  let acc = 0;
  for (let i = 0; i < others.length; i++) {
    const d = others[i].end - others[i].start;
    // Past the halfway line of a clip is past that clip.
    if (centre < acc + d / 2) return i;
    acc += d;
  }
  return others.length;
}

export const duration = (edl: Edl): Sec => {
  const video = placed(edl).at(-1)?.end ?? 0;
  const text = edl.text.reduce((m, t) => Math.max(m, t.at + t.dur), 0);
  return Math.max(video, text);
};

/** Which clip is on screen at timeline time `t`, and how far into its source. */
export function resolve(edl: Edl, t: Sec): { clip: Clip; sourceTime: Sec } | null {
  for (const p of placed(edl)) {
    if (t >= p.start && t < p.end) {
      if (isSlug(p.clip)) return null;
      return { clip: p.clip, sourceTime: p.clip.in + (t - p.start) * (p.clip.speed ?? 1) };
    }
  }
  return null;
}

/**
 * Map a time in a source file to every timeline time it appears at. A source
 * moment can appear more than once (or not at all) once it has been cut up.
 */
export function sourceToTimeline(edl: Edl, mediaId: string, sourceTime: Sec): Sec[] {
  const hits: Sec[] = [];
  for (const p of placed(edl)) {
    if (p.clip.src !== mediaId) continue;
    if (sourceTime >= p.clip.in && sourceTime < p.clip.out) {
      hits.push(p.start + (sourceTime - p.clip.in) / (p.clip.speed ?? 1));
    }
  }
  return hits;
}

/** Map a source-time range onto timeline ranges. Used to turn analysis
 *  (silences, transcript spans) into edits. */
export function sourceRangeToTimeline(
  edl: Edl,
  mediaId: string,
  from: Sec,
  to: Sec,
): Array<[Sec, Sec]> {
  const out: Array<[Sec, Sec]> = [];
  for (const p of placed(edl)) {
    const c = p.clip;
    if (c.src !== mediaId) continue;
    const lo = Math.max(from, c.in);
    const hi = Math.min(to, c.out);
    if (hi <= lo) continue;
    const rate = c.speed ?? 1;
    out.push([p.start + (lo - c.in) / rate, p.start + (hi - c.in) / rate]);
  }
  return out;
}

export const fmt = (t: Sec): string => {
  const sign = t < 0 ? "-" : "";
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = Math.floor(a % 60);
  const cs = Math.floor((a % 1) * 100);
  return `${sign}${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

export const FULL_FRAME: Crop = { x: 0, y: 0, w: 1, h: 1 };

export const cropOf = (edl: Edl): Crop => edl.crop ?? FULL_FRAME;

export const isCropped = (edl: Edl): boolean => {
  const c = cropOf(edl);
  return c.x !== 0 || c.y !== 0 || c.w !== 1 || c.h !== 1;
};

/** Pixel dimensions of the framed output, rounded to even numbers so the
 *  result stays encodable. */
export function outputSize(edl: Edl): { width: number; height: number } {
  const c = cropOf(edl);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(edl.width * c.w), height: even(edl.height * c.h) };
}

/* ---------------------------------------------------------------------------
   Effects
   ------------------------------------------------------------------------- */

import type { Effect, Fade, Track, Zoom } from "./types";

export const tracksOf = (edl: Edl): Track[] => edl.tracks ?? [];

export const allEffects = (edl: Edl): Effect[] => tracksOf(edl).flatMap((t) => t.items);

/** Smoothstep. A linear ramp on a zoom reads as a mechanical slide. */
const ease = (u: number) => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

/**
 * How far into an effect `t` sits, as 0..1 with the ends eased.
 * Returns 0 outside the interval.
 */
export function envelope(item: { at: Sec; dur: Sec }, t: Sec, ramp: Sec): number {
  if (t < item.at || t >= item.at + item.dur) return 0;
  if (ramp <= 0) return 1;
  const r = Math.min(ramp, item.dur / 2);
  const inFrom = t - item.at;
  const outTo = item.at + item.dur - t;
  if (inFrom < r) return ease(inFrom / r);
  if (outTo < r) return ease(outTo / r);
  return 1;
}

/** The zoom in effect at `t`. Later lanes win, so the last one applies. */
export function zoomAt(edl: Edl, t: Sec): { scale: number; x: number; y: number } | null {
  let hit: Zoom | null = null;
  for (const track of tracksOf(edl)) {
    for (const item of track.items) {
      if (item.kind !== "zoom") continue;
      if (t >= item.at && t < item.at + item.dur) hit = item;
    }
  }
  if (!hit) return null;
  const u = envelope(hit, t, hit.ramp);
  const scale = 1 + (hit.scale - 1) * u;
  return scale <= 1.0001 ? null : { scale, x: hit.x, y: hit.y };
}

/** The colour wash over the picture at `t`, if any. */
export function fadeAt(edl: Edl, t: Sec): { color: string; alpha: number } | null {
  let out: { color: string; alpha: number } | null = null;
  for (const track of tracksOf(edl)) {
    for (const item of track.items) {
      if (item.kind !== "fade") continue;
      if (t < item.at || t >= item.at + item.dur) continue;
      const u = (t - item.at) / item.dur;
      // in: starts opaque and clears. out: clears and closes. dip: both.
      const alpha =
        item.mode === "in" ? 1 - u : item.mode === "out" ? u : 1 - Math.abs(u * 2 - 1);
      if (alpha > 0.001) out = { color: item.color, alpha: Math.min(1, alpha) };
    }
  }
  return out;
}

export const isFade = (e: Effect): e is Fade => e.kind === "fade";
export const isZoom = (e: Effect): e is Zoom => e.kind === "zoom";
