import type { Edl, Sec } from "../edl/types";
import { duration, isSlug, placed, soundsOf } from "../edl/query";

/**
 * Everything about an export that is decided by the document alone: how many
 * frames to draw, which piece of which file each moment of audio comes from,
 * and what container to write. No browser APIs, so it is all testable.
 */

/** Frames in the finished file. */
export const frameCount = (edl: Edl): number => Math.max(1, Math.round(duration(edl) * edl.fps));

/** One source range feeding one window of the exported audio. */
export interface AudioPiece {
  /** Media id of the file to read. */
  src: string;
  /** Seconds into that file, and how far to read. */
  from: Sec;
  to: Sec;
  /** Where it lands in the window, in seconds from the window's start. */
  at: Sec;
  dur: Sec;
  /** 1 is the file's own level. */
  gain: number;
}

/**
 * What plays between two timeline times: the clips' own audio unless it is
 * muted, plus every sound item. A clip's speed stretches the source range it
 * reads, which is what keeps picture and sound together on a sped-up clip.
 */
export function audioPieces(edl: Edl, from: Sec, to: Sec): AudioPiece[] {
  const out: AudioPiece[] = [];
  if (!edl.videoMuted) {
    for (const p of placed(edl)) {
      if (isSlug(p.clip)) continue;
      const lo = Math.max(from, p.start);
      const hi = Math.min(to, p.end);
      if (hi <= lo) continue;
      const rate = p.clip.speed ?? 1;
      out.push({
        src: p.clip.src,
        from: p.clip.in + (lo - p.start) * rate,
        to: p.clip.in + (hi - p.start) * rate,
        at: lo - from,
        dur: hi - lo,
        gain: 1,
      });
    }
  }
  for (const s of soundsOf(edl)) {
    if (s.volume <= 0) continue;
    const lo = Math.max(from, s.at);
    const hi = Math.min(to, s.at + s.dur);
    if (hi <= lo) continue;
    out.push({
      src: s.src,
      from: s.in + (lo - s.at),
      to: s.in + (hi - s.at),
      at: lo - from,
      dur: hi - lo,
      gain: s.volume,
    });
  }
  return out;
}

/** Whether the finished file needs an audio track at all. */
export function wantsAudio(edl: Edl, hasSound: (mediaId: string) => boolean): boolean {
  if (soundsOf(edl).some((s) => s.volume > 0)) return true;
  if (edl.videoMuted) return false;
  return edl.clips.some((c) => !isSlug(c) && hasSound(c.src));
}

/** The timeline in windows, so audio is mixed a few seconds at a time instead of all at once. */
export function windows(total: Sec, size: Sec): Array<[Sec, Sec]> {
  const out: Array<[Sec, Sec]> = [];
  for (let t = 0; t < total; t += size) out.push([t, Math.min(total, t + size)]);
  return out.length ? out : [[0, 0]];
}

export type VideoCodecName = "avc" | "vp9" | "vp8";
export type AudioCodecName = "aac" | "opus";

export interface OutputChoice {
  container: "mp4" | "webm";
  video: VideoCodecName;
  /** Null when this browser can encode pictures but not sound. */
  audio: AudioCodecName | null;
}

/** MP4/H.264 first because it plays everywhere; WebM is the fallback when the browser cannot encode it. */
const CONTAINERS = [
  { container: "mp4", video: "avc", audio: "aac" },
  { container: "webm", video: "vp9", audio: "opus" },
  { container: "webm", video: "vp8", audio: "opus" },
] as const;

/**
 * Pick the container and codecs from what this browser can actually encode.
 * Keeping the sound beats keeping the container, so a browser that cannot
 * encode AAC exports WebM rather than a silent MP4.
 */
export function pickOutput(
  available: { video: readonly string[]; audio: readonly string[] },
  needsAudio: boolean,
): OutputChoice | null {
  const canV = (c: string) => available.video.includes(c);
  const canA = (c: string) => available.audio.includes(c);
  if (needsAudio) {
    const whole = CONTAINERS.find((o) => canV(o.video) && canA(o.audio));
    if (whole) return { container: whole.container, video: whole.video, audio: whole.audio };
  }
  const picture = CONTAINERS.find((o) => canV(o.video));
  if (!picture) return null;
  return {
    container: picture.container,
    video: picture.video,
    audio: needsAudio && canA(picture.audio) ? picture.audio : null,
  };
}

/** The saved file's name, from the footage it came from. */
export function exportName(sourceName: string | undefined, ext: string): string {
  const base = (sourceName ?? "").replace(/\.[^.]+$/, "").trim();
  return base ? `${base}-cutline.${ext}` : `cutline.${ext}`;
}
