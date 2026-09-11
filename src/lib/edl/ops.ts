import { nanoid } from "nanoid";
import type { Clip, Crop, Edl, Sec, TextClip } from "./types";
import { clipDur, FULL_FRAME, isSlug, placed, SLUG, snap } from "./query";

const id = () => nanoid(8);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Drop degenerate clips and frame-snap every boundary. Every op ends here. */
export function normalize(edl: Edl): Edl {
  const f = edl.fps;
  const next = clone(edl);
  next.clips = next.clips
    .map((c) => ({ ...c, in: snap(c.in, f), out: snap(c.out, f) }))
    .filter((c) => c.out - c.in > 1 / f / 2);
  // Gaps in one canonical form: 0 to their length, merged where they meet, never left at the end.
  const clips: Clip[] = [];
  for (const c of next.clips) {
    const last = clips.at(-1);
    if (!isSlug(c)) clips.push(c);
    else if (last && isSlug(last)) last.out = snap(last.out + c.out - c.in, f);
    else clips.push({ id: c.id, src: SLUG, in: 0, out: snap(c.out - c.in, f) });
  }
  while (clips.length && isSlug(clips[clips.length - 1])) clips.pop();
  next.clips = clips;
  next.text = next.text
    .map((t) => ({ ...t, at: snap(Math.max(0, t.at), f), dur: snap(t.dur, f) }))
    .filter((t) => t.dur > 0);
  // A crop covering the whole frame is the same as no crop; store the
  // simpler form so "is this cropped?" never depends on float noise.
  if (next.crop && next.crop.x === 0 && next.crop.y === 0 && next.crop.w === 1 && next.crop.h === 1) {
    delete next.crop;
  }
  if (next.tracks) {
    next.tracks = next.tracks.map((t) => ({
      ...t,
      items: t.items
        .map((e) => ({ ...e, at: snap(Math.max(0, e.at), f), dur: snap(e.dur, f) }))
        .filter((e) => e.dur >= 1 / f)
        .sort((a, b) => a.at - b.at),
    }));
    // An empty `tracks` array and no `tracks` mean the same thing; keep one
    // form so version diffs do not churn.
    if (!next.tracks.length) delete next.tracks;
  }
  return next;
}

/**
 * Remove a timeline range and close the gap. This is the workhorse: silence
 * removal, filler-word cuts and "trim to 60s" all reduce to repeated calls.
 */
export function rippleDelete(edl: Edl, start: Sec, end: Sec): Edl {
  const f = edl.fps;
  start = snap(Math.max(0, start), f);
  end = snap(end, f);
  if (end <= start) return edl;

  const next: Clip[] = [];
  for (const p of placed(edl)) {
    const c = p.clip;
    const rate = c.speed ?? 1;
    const lo = Math.max(start, p.start);
    const hi = Math.min(end, p.end);

    if (hi <= lo) {
      next.push(c); // no overlap
      continue;
    }
    if (lo <= p.start && hi >= p.end) continue; // swallowed whole

    const srcLo = c.in + (lo - p.start) * rate;
    const srcHi = c.in + (hi - p.start) * rate;
    const keepHead = srcLo > c.in;
    const keepTail = srcHi < c.out;
    if (keepHead) next.push({ ...c, out: srcLo });
    if (keepTail) next.push({ ...c, id: keepHead ? id() : c.id, in: srcHi });
  }

  // Overlays live in absolute time, so pull everything after the cut back.
  const delta = end - start;
  const map = (x: Sec) => (x <= start ? x : x >= end ? x - delta : start);
  const text = edl.text
    .map((t) => {
      const a = map(t.at);
      const b = map(t.at + t.dur);
      return { ...t, at: a, dur: b - a };
    })
    .filter((t) => t.dur > 0);

  return normalize({ ...edl, clips: next, text });
}

/** Merge overlapping or touching ranges into a disjoint, ascending set. */
export function mergeRanges(ranges: Array<[Sec, Sec]>): Array<[Sec, Sec]> {
  const sorted = [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[Sec, Sec]> = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Remove many ranges at once, all measured against the *current* timeline.
 *
 * Two things are load-bearing here. Ranges are merged first, because
 * overlapping inputs would otherwise each delete a full width and eat
 * material between them. Then they are applied back to front, so that
 * earlier ranges are still valid after later ones shift the timeline.
 */
export function rippleDeleteMany(edl: Edl, ranges: Array<[Sec, Sec]>): Edl {
  const merged = mergeRanges(ranges);
  return merged.reverse().reduce((acc, [a, b]) => rippleDelete(acc, a, b), edl);
}

/** Cut the clip under `t` in two. A no-op on a clip boundary. */
export function splitAt(edl: Edl, t: Sec): Edl {
  const f = edl.fps;
  t = snap(t, f);
  const next: Clip[] = [];
  for (const p of placed(edl)) {
    const c = p.clip;
    if (t > p.start && t < p.end) {
      const at = c.in + (t - p.start) * (c.speed ?? 1);
      next.push({ ...c, out: at }, { ...c, id: id(), in: at });
    } else {
      next.push(c);
    }
  }
  return normalize({ ...edl, clips: next });
}

export function deleteClip(edl: Edl, clipId: string): Edl {
  const p = placed(edl).find((x) => x.clip.id === clipId);
  if (!p) return edl;
  return rippleDelete(edl, p.start, p.end);
}

/** Retime a clip's source window without moving anything else. */
export function trimClip(edl: Edl, clipId: string, inPt?: Sec, outPt?: Sec): Edl {
  const clips = edl.clips.map((c) =>
    c.id === clipId && !isSlug(c) ? { ...c, in: inPt ?? c.in, out: outPt ?? c.out } : c,
  );
  return normalize({ ...edl, clips });
}

const slug = (slugId: string, dur: Sec): Clip => ({ id: slugId, src: SLUG, in: 0, out: dur });

/** Drag one edge of a clip: only that edge moves, and a slug holds any space it frees. */
export function trimClipEdge(
  edl: Edl,
  clipId: string,
  edge: "start" | "end",
  timelineT: Sec,
  sourceDur?: Sec,
): Edl {
  const spots = placed(edl);
  const i = spots.findIndex((p) => p.clip.id === clipId);
  const spot = spots[i];
  if (!spot || isSlug(spot.clip)) return edl;
  const c = spot.clip;
  const rate = c.speed ?? 1;
  // Two frames is the shortest clip worth having.
  const shortest = 2 / edl.fps;
  const clips = [...edl.clips];

  if (edge === "start") {
    const before = spots[i - 1];
    const gap = before && isSlug(before.clip) ? before.end - before.start : 0;
    // Back out only as far as the gap before it and its own footage allow.
    const at = Math.min(spot.end - shortest, Math.max(spot.start - gap, spot.start - c.in / rate, timelineT));
    const d = at - spot.start;
    clips[i] = { ...c, in: c.in + d * rate };
    if (gap) clips[i - 1] = slug(before.clip.id, gap + d);
    else if (d > 0) clips.splice(i, 0, slug(id(), d));
  } else {
    const after = spots[i + 1];
    const gap = after && isSlug(after.clip) ? after.end - after.start : 0;
    // The last clip is free to grow to the end of its footage; any other stops at the next clip.
    const room = after ? gap : Number.POSITIVE_INFINITY;
    const footage = sourceDur === undefined ? Number.POSITIVE_INFINITY : spot.start + (sourceDur - c.in) / rate;
    const at = Math.max(spot.start + shortest, Math.min(spot.end + room, footage, timelineT));
    const d = at - spot.end;
    clips[i] = { ...c, out: c.out + d * rate };
    if (gap) clips[i + 1] = slug(after.clip.id, gap - d);
    else if (after && d < 0) clips.splice(i + 1, 0, slug(id(), -d));
  }
  return normalize({ ...edl, clips });
}

/** Reorder a clip within the track. */
export function moveClip(edl: Edl, clipId: string, toIndex: number): Edl {
  const from = edl.clips.findIndex((c) => c.id === clipId);
  if (from < 0) return edl;
  const clips = [...edl.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(Math.max(0, Math.min(clips.length, toIndex)), 0, c);
  return normalize({ ...edl, clips });
}

/** Two clips trade places; any gap between them stays where it is. */
export function swapClips(edl: Edl, aId: string, bId: string): Edl {
  const i = edl.clips.findIndex((c) => c.id === aId);
  const j = edl.clips.findIndex((c) => c.id === bId);
  if (i < 0 || j < 0 || i === j) return edl;
  const clips = [...edl.clips];
  [clips[i], clips[j]] = [clips[j], clips[i]];
  return normalize({ ...edl, clips });
}

export function setSpeed(edl: Edl, clipId: string, rate: number): Edl {
  const clips = edl.clips.map((c) => (c.id === clipId && !isSlug(c) ? { ...c, speed: rate } : c));
  return normalize({ ...edl, clips });
}

export function insertClip(
  edl: Edl,
  clip: { src: string; in: Sec; out: Sec; speed?: number },
  atIndex?: number,
): Edl {
  const c: Clip = { id: id(), ...clip };
  const clips = [...edl.clips];
  clips.splice(atIndex ?? clips.length, 0, c);
  return normalize({ ...edl, clips });
}

export function addText(edl: Edl, t: Omit<TextClip, "id">): Edl {
  return normalize({ ...edl, text: [...edl.text, { id: id(), ...t }] });
}

export function updateText(edl: Edl, textId: string, patch: Partial<Omit<TextClip, "id">>): Edl {
  const text = edl.text.map((t) => (t.id === textId ? { ...t, ...patch } : t));
  return normalize({ ...edl, text });
}

export function removeText(edl: Edl, textId: string): Edl {
  return normalize({ ...edl, text: edl.text.filter((t) => t.id !== textId) });
}

/** Set the reframe. Clamped so the rectangle always stays inside the frame. */
export function setCrop(edl: Edl, crop: Partial<Crop>): Edl {
  const cur = edl.crop ?? FULL_FRAME;
  const w = Math.min(1, Math.max(0.05, crop.w ?? cur.w));
  const h = Math.min(1, Math.max(0.05, crop.h ?? cur.h));
  const x = Math.min(1 - w, Math.max(0, crop.x ?? cur.x));
  const y = Math.min(1 - h, Math.max(0, crop.y ?? cur.y));
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return normalize({ ...edl, crop: { x: r(x), y: r(y), w: r(w), h: r(h) } });
}

/**
 * Centre the largest rectangle of the given aspect that fits the frame.
 * `aspect` is width divided by height; pass null to restore the full frame.
 */
export function setCropAspect(edl: Edl, aspect: number | null): Edl {
  if (!aspect) return resetCrop(edl);
  const frame = edl.width / edl.height;
  const w = aspect >= frame ? 1 : aspect / frame;
  const h = aspect >= frame ? frame / aspect : 1;
  return setCrop(edl, { w, h, x: (1 - w) / 2, y: (1 - h) / 2 });
}

/** Back to the full frame. Nothing about the crop is destructive. */
export function resetCrop(edl: Edl): Edl {
  const next = { ...edl };
  delete next.crop;
  return normalize(next);
}

/** Keep only [start, end) of the timeline. */
export function trimTimeline(edl: Edl, start: Sec, end: Sec): Edl {
  const total = placed(edl).at(-1)?.end ?? 0;
  let out = edl;
  if (end < total) out = rippleDelete(out, end, total);
  if (start > 0) out = rippleDelete(out, 0, start);
  return out;
}

export { clipDur };

/* ---------------------------------------------------------------------------
   Effect lanes

   Every effect is an interval, so one set of operations covers fades, zooms
   and anything added later.
   ------------------------------------------------------------------------- */

import type { Effect, Track, TrackKind } from "./types";
import { tracksOf } from "./query";

/** A palette grounded in what film actually fades to. */
export const FADE_COLORS: Array<{ name: string; value: string }> = [
  { name: "Black", value: "#000000" },
  { name: "White", value: "#ffffff" },
  { name: "Warm black", value: "#0d0906" },
  { name: "Print blue", value: "#0a1826" },
  { name: "Sepia", value: "#3a2a18" },
  { name: "Leader", value: "#e0a92e" },
  { name: "Grease", value: "#d2503f" },
  { name: "Bone", value: "#e8e2d4" },
];

const TRACK_NAMES: Record<TrackKind, string> = { fade: "Fade", zoom: "Zoom" };

/**
 * At most one lane per kind. Every fade lives on the fade lane, so there is
 * one place to look for a fade and no question about which lane wins.
 * Adding a lane that already exists is a no-op, not an error.
 */
export function addTrack(edl: Edl, kind: TrackKind): Edl {
  const tracks = tracksOf(edl);
  if (tracks.some((t) => t.kind === kind)) return edl;
  const track: Track = { id: id(), kind, name: TRACK_NAMES[kind], items: [] };
  // Fades sit under zooms, matching the order they are composited in.
  const next = [...tracks, track].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "fade" ? -1 : 1));
  return normalize({ ...edl, tracks: next });
}

export const trackFor = (edl: Edl, kind: TrackKind): Track | null =>
  tracksOf(edl).find((t) => t.kind === kind) ?? null;

export function removeTrack(edl: Edl, trackId: string): Edl {
  return normalize({ ...edl, tracks: tracksOf(edl).filter((t) => t.id !== trackId) });
}

export function renameTrack(edl: Edl, trackId: string, name: string): Edl {
  return normalize({
    ...edl,
    tracks: tracksOf(edl).map((t) => (t.id === trackId ? { ...t, name } : t)),
  });
}

/** Default shapes, so adding an effect lands somewhere usable immediately. */
export function makeEffect(kind: TrackKind, at: Sec, dur = 1): Effect {
  return kind === "fade"
    ? { id: id(), kind: "fade", at, dur, color: "#000000", mode: "out" }
    : { id: id(), kind: "zoom", at, dur: Math.max(dur, 1.2), scale: 1.4, x: 0.5, y: 0.45, ramp: 0.4 };
}

export function addEffect(edl: Edl, trackId: string, effect: Effect): Edl {
  return normalize({
    ...edl,
    tracks: tracksOf(edl).map((t) =>
      t.id === trackId ? { ...t, items: [...t.items, effect] } : t,
    ),
  });
}

export function updateEffect(edl: Edl, effectId: string, patch: Partial<Effect>): Edl {
  return normalize({
    ...edl,
    tracks: tracksOf(edl).map((t) => ({
      ...t,
      items: t.items.map((e) => (e.id === effectId ? ({ ...e, ...patch } as Effect) : e)),
    })),
  });
}

export function removeEffect(edl: Edl, effectId: string): Edl {
  return normalize({
    ...edl,
    tracks: tracksOf(edl).map((t) => ({ ...t, items: t.items.filter((e) => e.id !== effectId) })),
  });
}

/** Slide an effect without changing its length. */
export function moveEffect(edl: Edl, effectId: string, at: Sec): Edl {
  return updateEffect(edl, effectId, { at: Math.max(0, at) } as Partial<Effect>);
}

/**
 * Drag one edge. The opposite edge stays put, which is what makes a trim a
 * trim rather than a move.
 */
export function trimEffect(edl: Edl, effectId: string, edge: "start" | "end", t: Sec): Edl {
  const MIN = 0.08;
  for (const track of tracksOf(edl)) {
    const item = track.items.find((e) => e.id === effectId);
    if (!item) continue;
    if (edge === "start") {
      const end = item.at + item.dur;
      const at = Math.max(0, Math.min(end - MIN, t));
      return updateEffect(edl, effectId, { at, dur: end - at } as Partial<Effect>);
    }
    const dur = Math.max(MIN, t - item.at);
    return updateEffect(edl, effectId, { dur } as Partial<Effect>);
  }
  return edl;
}

export const findEffect = (edl: Edl, effectId: string): Effect | null =>
  tracksOf(edl).flatMap((t) => t.items).find((e) => e.id === effectId) ?? null;

export const trackOfEffect = (edl: Edl, effectId: string): Track | null =>
  tracksOf(edl).find((t) => t.items.some((e) => e.id === effectId)) ?? null;
