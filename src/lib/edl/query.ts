import type { Clip, Edl, Sec } from "./types";

/**
 * Snap to a frame boundary. Every op runs its results through this so the same
 * edit always produces byte-identical JSON — which is what makes the version
 * history diffable instead of noisy with float drift.
 */
export const snap = (t: Sec, fps: number): Sec => Math.round(t * fps) / fps;

/** Duration this clip occupies on the timeline, after speed. */
export const clipDur = (c: Clip): Sec => Math.max(0, c.out - c.in) / (c.speed ?? 1);

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

export const duration = (edl: Edl): Sec => {
  const video = placed(edl).at(-1)?.end ?? 0;
  const text = edl.text.reduce((m, t) => Math.max(m, t.at + t.dur), 0);
  return Math.max(video, text);
};

/** Which clip is on screen at timeline time `t`, and how far into its source. */
export function resolve(edl: Edl, t: Sec): { clip: Clip; sourceTime: Sec } | null {
  for (const p of placed(edl)) {
    if (t >= p.start && t < p.end) {
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
