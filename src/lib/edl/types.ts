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

/**
 * Reframing, as a fraction of the composition frame. Normalised rather than
 * in pixels so it survives a source of any resolution, and so "no crop" is
 * literally the unit rectangle.
 */
export const CropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0.05).max(1),
  h: z.number().min(0.05).max(1),
});

/**
 * Effects live on their own lanes, below the video. Each is an interval with
 * a start and a duration, so the same trim gesture works on every one of them
 * and the timeline needs one interaction model rather than several.
 */
export const FadeSchema = z.object({
  id: z.string(),
  kind: z.literal("fade"),
  at: z.number().min(0),
  dur: z.number().min(0.04),
  /** The colour the picture resolves to or from. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** in: from colour. out: to colour. dip: through it and back. */
  mode: z.enum(["in", "out", "dip"]),
});

export const ZoomSchema = z.object({
  id: z.string(),
  kind: z.literal("zoom"),
  at: z.number().min(0),
  dur: z.number().min(0.04),
  scale: z.number().min(1).max(4),
  /** Focal point as a fraction of the frame; 0.5, 0.5 is centre. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** Seconds spent easing in and out. Zero snaps. */
  ramp: z.number().min(0).max(5),
});

export const EffectSchema = z.discriminatedUnion("kind", [FadeSchema, ZoomSchema]);

export const TrackSchema = z.object({
  id: z.string(),
  kind: z.enum(["fade", "zoom"]),
  name: z.string(),
  items: z.array(EffectSchema),
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
  /** Absent means the full frame. */
  crop: CropSchema.optional(),
  /** Effect lanes, drawn below the video track in this order. */
  tracks: z.array(TrackSchema).optional(),
});

export type Crop = z.infer<typeof CropSchema>;
export type Fade = z.infer<typeof FadeSchema>;
export type Zoom = z.infer<typeof ZoomSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type TrackKind = Track["kind"];
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
