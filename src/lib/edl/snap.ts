import type { Edl, Sec } from "./types";
import { duration, placed, tracksOf } from "./query";

/**
 * Magnetic alignment. Lanes only read as one instrument if a fade can land
 * exactly on the cut it belongs to, and a pointer cannot hit a frame boundary
 * on its own: at a normal zoom one frame is well under a pixel, so "close
 * enough" would leave a sliver that shows up as a flash in the export.
 */

export interface SnapOptions {
  /** Extra positions worth catching, such as the playhead. */
  extra?: Sec[];
  /** An item's own edges, so a drag never snaps to where it already is. */
  exceptId?: string;
}

/** Every timeline position worth catching: the ends, each cut, and each lane item's edges. */
export function snapPoints(edl: Edl, { extra = [], exceptId }: SnapOptions = {}): Sec[] {
  const points = [0, duration(edl)];
  for (const p of placed(edl)) points.push(p.start, p.end);
  for (const track of tracksOf(edl)) {
    for (const item of track.items) {
      if (item.id === exceptId) continue;
      points.push(item.at, item.at + item.dur);
    }
  }
  for (const t of extra) if (Number.isFinite(t)) points.push(t);
  return [...new Set(points.filter((t) => t >= 0))].sort((a, b) => a - b);
}

/** The nearest point within `tolerance`, or the time unchanged. */
export function snapTo(t: Sec, points: Sec[], tolerance: Sec): { t: Sec; hit: Sec | null } {
  let best: Sec | null = null;
  let gap = tolerance;
  for (const p of points) {
    const d = Math.abs(p - t);
    // `<=` so the nearer of two equal candidates is the earlier one, which keeps a drag from flickering between them.
    if (d <= gap) {
      gap = d;
      best = p;
    }
  }
  return best === null ? { t, hit: null } : { t: best, hit: best };
}

/**
 * Snap a whole item by whichever edge is closer, keeping its length. Moving a
 * sound to meet a cut means its head or its tail meets the cut, and which one
 * the user meant is simply the one they dragged nearer.
 */
export function snapInterval(
  at: Sec,
  dur: Sec,
  points: Sec[],
  tolerance: Sec,
): { at: Sec; hit: Sec | null } {
  const head = snapTo(at, points, tolerance);
  const tail = snapTo(at + dur, points, tolerance);
  const headGap = head.hit === null ? Infinity : Math.abs(head.hit - at);
  const tailGap = tail.hit === null ? Infinity : Math.abs(tail.hit - (at + dur));
  if (headGap === Infinity && tailGap === Infinity) return { at, hit: null };
  return headGap <= tailGap ? { at: head.t, hit: head.hit } : { at: tail.t - dur, hit: tail.hit };
}
