import { nanoid } from "nanoid";
import type { Clip, Edl, Sec, TextClip } from "./types";
import { clipDur, placed, snap } from "./query";

const id = () => nanoid(8);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Drop degenerate clips and frame-snap every boundary. Every op ends here. */
export function normalize(edl: Edl): Edl {
  const f = edl.fps;
  const next = clone(edl);
  next.clips = next.clips
    .map((c) => ({ ...c, in: snap(c.in, f), out: snap(c.out, f) }))
    .filter((c) => c.out - c.in > 1 / f / 2);
  next.text = next.text
    .map((t) => ({ ...t, at: snap(Math.max(0, t.at), f), dur: snap(t.dur, f) }))
    .filter((t) => t.dur > 0);
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
    c.id === clipId ? { ...c, in: inPt ?? c.in, out: outPt ?? c.out } : c,
  );
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

export function setSpeed(edl: Edl, clipId: string, rate: number): Edl {
  const clips = edl.clips.map((c) => (c.id === clipId ? { ...c, speed: rate } : c));
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

/** Keep only [start, end) of the timeline. */
export function trimTimeline(edl: Edl, start: Sec, end: Sec): Edl {
  const total = placed(edl).at(-1)?.end ?? 0;
  let out = edl;
  if (end < total) out = rippleDelete(out, end, total);
  if (start > 0) out = rippleDelete(out, 0, start);
  return out;
}

export { clipDur };
