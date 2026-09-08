import { z } from "zod";

/** Seconds on the timeline or in a source file. Always frame-snapped. */
export type Sec = number;

export const ClipSchema = z.object({
  id: z.string(),
  /** Media id in the OPFS store. */
  src: z.string(),
  /** Source in-point, seconds into the original file. */
  in: z.number().min(0),
  /** Source out-point, exclusive. */
  out: z.number().min(0),
  /** Playback rate. 2 = twice as fast, so half the timeline duration. */
  speed: z.number().min(0.1).max(10).optional(),
});

export const TextClipSchema = z.object({
  id: z.string(),
  /** Absolute timeline position. */
  at: z.number().min(0),
  dur: z.number().min(0),
  content: z.string(),
  style: z.enum(["title", "lower-third", "caption"]),
});

export const EdlSchema = z.object({
  version: z.literal(1),
  fps: z.number().int().min(1).max(120),
  width: z.number().int(),
  height: z.number().int(),
  /**
   * The video track. Contiguous by construction: clips play back to back in
   * array order, so a clip's timeline position is the sum of the durations
   * before it. Nothing stores `at`, which means a ripple edit touches one
   * array entry instead of rewriting a position on every clip after it — the
   * version diffs stay readable.
   */
  clips: z.array(ClipSchema),
  /** Overlays, positioned absolutely on the timeline. */
  text: z.array(TextClipSchema),
});

export type Clip = z.infer<typeof ClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type Edl = z.infer<typeof EdlSchema>;

export const emptyEdl = (fps = 30, width = 1920, height = 1080): Edl => ({
  version: 1,
  fps,
  width,
  height,
  clips: [],
  text: [],
});
