import type Anthropic from "@anthropic-ai/sdk";
import type { Edl } from "../edl/types";
import {
  cropOf, duration, fmt, isCropped, isFade, outputSize, placed,
  sourceRangeToTimeline, tracksOf,
} from "../edl/query";
import {
  addEffect, addText, addTrack, deleteClip, FADE_COLORS, makeEffect, moveClip,
  removeText, resetCrop, rippleDelete, rippleDeleteMany, setCropAspect,
  setSpeed, splitAt, trackFor, trimClip, trimTimeline,
} from "../edl/ops";

export interface MediaInfo {
  id: string;
  name: string;
  duration: number;
}

/** What the agent knows about the footage beyond the edit itself. */
export interface Analysis {
  /** mediaId -> silence ranges in source-file seconds. */
  silences: Record<string, Array<[number, number]>>;
}

export interface AgentContext {
  media: MediaInfo[];
  analysis: Analysis;
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties: props,
  required,
  additionalProperties: false,
});

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });

/**
 * The agent's entire surface. Deliberately small: every tool is a pure
 * function over the edit document, so a bad call can never corrupt media,
 * only produce a version the user can restore away from.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "remove_silences",
    description:
      "Remove dead air across the whole timeline using the silence analysis already computed for each source file. This is the right tool for 'cut the silences', 'remove pauses', 'tighten this up', or 'remove dead air'. Prefer it over many manual ripple_delete calls.",
    strict: true,
    input_schema: obj(
      {
        min_silence: num("Shortest pause to remove, in seconds. Default 0.35. Raise it to be more conservative."),
        padding: num("Silence to leave on each side of a cut so speech is not clipped. Default 0.08."),
      },
      [],
    ),
  },
  {
    name: "ripple_delete",
    description:
      "Delete a timeline range and close the gap. Times are timeline seconds, not source-file seconds.",
    strict: true,
    input_schema: obj({ start: num("Timeline seconds."), end: num("Timeline seconds, exclusive.") }, ["start", "end"]),
  },
  {
    name: "trim_timeline",
    description:
      "Keep only a window of the timeline and discard everything outside it. Use for 'cut this down to the first 30 seconds'.",
    strict: true,
    input_schema: obj({ start: num("Timeline seconds."), end: num("Timeline seconds.") }, ["start", "end"]),
  },
  {
    name: "split",
    description: "Split the clip at a timeline position into two clips. Does not remove anything.",
    strict: true,
    input_schema: obj({ at: num("Timeline seconds.") }, ["at"]),
  },
  {
    name: "delete_clip",
    description: "Remove one clip by id and close the gap.",
    strict: true,
    input_schema: obj({ clip_id: str("Clip id from the timeline listing.") }, ["clip_id"]),
  },
  {
    name: "trim_clip",
    description:
      "Change a clip's source in/out points without moving other clips. Times are seconds into the SOURCE file.",
    strict: true,
    input_schema: obj(
      { clip_id: str("Clip id."), in: num("Source seconds."), out: num("Source seconds.") },
      ["clip_id"],
    ),
  },
  {
    name: "move_clip",
    description: "Reorder a clip to a new zero-based index in the track.",
    strict: true,
    input_schema: obj({ clip_id: str("Clip id."), to_index: num("Zero-based target index.") }, ["clip_id", "to_index"]),
  },
  {
    name: "set_speed",
    description: "Change a clip's playback rate. 2 plays twice as fast and halves its timeline duration.",
    strict: true,
    input_schema: obj({ clip_id: str("Clip id."), rate: num("0.1 to 10.") }, ["clip_id", "rate"]),
  },
  {
    name: "add_text",
    description: "Add a text overlay at an absolute timeline position.",
    strict: true,
    input_schema: obj(
      {
        at: num("Timeline seconds."),
        dur: num("Seconds on screen."),
        content: str("The text."),
        style: { type: "string", enum: ["title", "lower-third", "caption"], description: "Visual treatment." },
      },
      ["at", "dur", "content", "style"],
    ),
  },
  {
    name: "add_fade",
    description:
      "Put a fade on the fade lane, creating that lane if it does not exist yet. Use for 'fade in at the start', 'fade to black at the end', or 'dip to white here'.",
    strict: true,
    input_schema: obj(
      {
        at: num("Timeline seconds where the fade starts."),
        dur: num("Length in seconds. Around 1 second reads as a normal fade."),
        mode: {
          type: "string",
          enum: ["in", "out", "dip"],
          description: "in opens from the colour, out closes to it, dip passes through and back.",
        },
        color: str("Hex colour such as #000000. Defaults to black."),
      },
      ["at", "dur", "mode"],
    ),
  },
  {
    name: "add_zoom",
    description:
      "Put a punch-in on the zoom lane, creating that lane if it does not exist yet. Use for 'zoom in on this bit' or 'push in while he says the number'.",
    strict: true,
    input_schema: obj(
      {
        at: num("Timeline seconds where the zoom starts."),
        dur: num("How long it stays zoomed, in seconds."),
        scale: num("1 to 4. Around 1.4 is a gentle punch-in."),
        x: num("Focal point across the frame, 0 to 1. Defaults to centre."),
        y: num("Focal point down the frame, 0 to 1. Defaults to slightly above centre."),
      },
      ["at", "dur", "scale"],
    ),
  },
  {
    name: "reframe",
    description:
      "Crop the finished video to an aspect ratio, centred on the frame. Use for 'make this vertical for TikTok', 'crop to square', or 'make it 9:16'. Pass reset to put the full frame back.",
    strict: true,
    input_schema: obj(
      {
        aspect: {
          type: "string",
          enum: ["16:9", "9:16", "1:1", "4:5", "4:3", "reset"],
          description: "Target aspect ratio, or reset for the full frame.",
        },
      },
      ["aspect"],
    ),
  },
  {
    name: "remove_text",
    description: "Remove a text overlay by id.",
    strict: true,
    input_schema: obj({ text_id: str("Text overlay id.") }, ["text_id"]),
  },
];

export interface ToolOutcome {
  edl: Edl;
  /** What to show the user in the activity log. */
  summary: string;
  /** What to send back to the model. */
  result: string;
}

type Input = Record<string, unknown>;
const n = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const s = (v: unknown, d = "") => (typeof v === "string" ? v : d);

/** Execute one tool call. Pure: same input, same output, no I/O. */
export function applyTool(edl: Edl, ctx: AgentContext, name: string, input: Input): ToolOutcome {
  const before = duration(edl);
  const done = (next: Edl, summary: string): ToolOutcome => ({
    edl: next,
    summary,
    result: `${summary}. Timeline is now ${fmt(duration(next))} with ${next.clips.length} clip(s).`,
  });

  switch (name) {
    case "remove_silences": {
      const minSilence = n(input.min_silence, 0.35);
      const padding = n(input.padding, 0.08);
      const ranges: Array<[number, number]> = [];
      for (const [mediaId, list] of Object.entries(ctx.analysis.silences ?? {})) {
        for (const [a, b] of list) {
          // Stored ranges are raw (unpadded) detections, so the model can
          // retune min_silence and padding per request without re-analysing
          // the audio. Filter first, then pad, then map source time onto
          // wherever that footage currently sits on the timeline.
          if (b - a < minSilence) continue;
          const lo = a + padding;
          const hi = b - padding;
          if (hi - lo <= 0.05) continue;
          ranges.push(...sourceRangeToTimeline(edl, mediaId, lo, hi));
        }
      }
      if (!ranges.length) return done(edl, "No removable silence found");
      const next = rippleDeleteMany(edl, ranges);
      const saved = before - duration(next);
      return done(next, `Removed ${ranges.length} silent stretch${ranges.length > 1 ? "es" : ""} (−${saved.toFixed(1)}s)`);
    }
    case "ripple_delete": {
      const a = n(input.start);
      const b = n(input.end);
      return done(rippleDelete(edl, a, b), `Cut ${fmt(a)}–${fmt(b)}`);
    }
    case "trim_timeline": {
      const a = n(input.start);
      const b = n(input.end, before);
      return done(trimTimeline(edl, a, b), `Trimmed to ${fmt(a)}–${fmt(b)}`);
    }
    case "split":
      return done(splitAt(edl, n(input.at)), `Split at ${fmt(n(input.at))}`);
    case "delete_clip":
      return done(deleteClip(edl, s(input.clip_id)), `Deleted clip ${s(input.clip_id)}`);
    case "trim_clip": {
      const id = s(input.clip_id);
      const c = edl.clips.find((x) => x.id === id);
      return done(
        trimClip(edl, id, input.in === undefined ? undefined : n(input.in), input.out === undefined ? undefined : n(input.out)),
        `Trimmed clip ${id}${c ? "" : " (not found)"}`,
      );
    }
    case "move_clip":
      return done(moveClip(edl, s(input.clip_id), n(input.to_index)), `Moved clip ${s(input.clip_id)}`);
    case "set_speed":
      return done(setSpeed(edl, s(input.clip_id), n(input.rate, 1)), `Set clip ${s(input.clip_id)} to ${n(input.rate, 1)}×`);
    case "add_text": {
      const content = s(input.content);
      return done(
        addText(edl, {
          at: n(input.at),
          dur: n(input.dur, 3),
          content,
          style: (s(input.style, "caption") as "title" | "lower-third" | "caption"),
        }),
        `Added text “${content.slice(0, 40)}”`,
      );
    }
    case "add_fade": {
      const at = n(input.at);
      const dur = Math.max(0.08, n(input.dur, 1));
      const mode = s(input.mode, "out") as "in" | "out" | "dip";
      const color = /^#[0-9a-fA-F]{6}$/.test(s(input.color)) ? s(input.color) : "#000000";
      // The lane is created on demand, so the model never has to sequence a
      // setup call before the call it actually wants.
      const withLane = trackFor(edl, "fade") ? edl : addTrack(edl, "fade");
      const lane = trackFor(withLane, "fade")!;
      const item = { ...makeEffect("fade", at, dur), dur, mode, color } as never;
      const named = FADE_COLORS.find((c) => c.value === color)?.name ?? color;
      return done(
        addEffect(withLane, lane.id, item),
        `Added a ${mode === "dip" ? "dip through" : `fade ${mode}`} ${named.toLowerCase()} at ${fmt(at)}`,
      );
    }
    case "add_zoom": {
      const at = n(input.at);
      const dur = Math.max(0.24, n(input.dur, 2));
      const scale = Math.min(4, Math.max(1, n(input.scale, 1.4)));
      const withLane = trackFor(edl, "zoom") ? edl : addTrack(edl, "zoom");
      const lane = trackFor(withLane, "zoom")!;
      const item = {
        ...makeEffect("zoom", at, dur),
        dur,
        scale,
        x: Math.min(1, Math.max(0, n(input.x, 0.5))),
        y: Math.min(1, Math.max(0, n(input.y, 0.45))),
      } as never;
      return done(addEffect(withLane, lane.id, item), `Added a ${scale.toFixed(2)}× zoom at ${fmt(at)}`);
    }
    case "reframe": {
      const key = s(input.aspect, "reset");
      if (key === "reset") return done(resetCrop(edl), "Restored the full frame");
      const ratios: Record<string, number> = {
        "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5, "4:3": 4 / 3,
      };
      const aspect = ratios[key];
      if (!aspect) return { edl, summary: `Unknown aspect ${key}`, result: `Error: unknown aspect ${key}.` };
      const next = setCropAspect(edl, aspect);
      const size = outputSize(next);
      return done(next, `Reframed to ${key} (${size.width} × ${size.height})`);
    }
    case "remove_text":
      return done(removeText(edl, s(input.text_id)), `Removed text ${s(input.text_id)}`);
    default:
      return { edl, summary: `Unknown tool ${name}`, result: `Error: no tool named ${name}.` };
  }
}

/** A compact, readable snapshot of the edit for the model's context. */
export function describeState(edl: Edl, ctx: AgentContext): string {
  const lines: string[] = [];
  const size = outputSize(edl);
  lines.push(`Timeline: ${fmt(duration(edl))}, ${edl.clips.length} clip(s), ${edl.fps}fps`);
  lines.push(`Frame: source ${edl.width}x${edl.height}, output ${size.width}x${size.height}`);
  if (isCropped(edl)) {
    const c = cropOf(edl);
    lines.push(`Cropped: x=${c.x} y=${c.y} w=${c.w} h=${c.h} of the frame`);
  }

  lines.push("", "Clips (timeline position | source range):");
  for (const p of placed(edl)) {
    const m = ctx.media.find((x) => x.id === p.clip.src);
    const speed = p.clip.speed && p.clip.speed !== 1 ? ` ${p.clip.speed}x` : "";
    lines.push(
      `  [${p.index}] id=${p.clip.id} ${fmt(p.start)}–${fmt(p.end)} | ${m?.name ?? p.clip.src} ${fmt(p.clip.in)}–${fmt(p.clip.out)}${speed}`,
    );
  }
  if (!edl.clips.length) lines.push("  (empty)");

  if (edl.text.length) {
    lines.push("", "Text overlays:");
    for (const t of edl.text) {
      lines.push(`  id=${t.id} ${fmt(t.at)} +${t.dur}s [${t.style}] “${t.content}”`);
    }
  }

  const lanes = tracksOf(edl);
  if (lanes.length) {
    lines.push("", "Effect lanes:");
    for (const lane of lanes) {
      if (!lane.items.length) {
        lines.push(`  ${lane.name}: empty`);
        continue;
      }
      for (const item of lane.items) {
        lines.push(
          isFade(item)
            ? `  ${lane.name} id=${item.id} ${fmt(item.at)} +${item.dur}s ${item.mode} ${item.color}`
            : `  ${lane.name} id=${item.id} ${fmt(item.at)} +${item.dur}s ${item.scale}x at ${item.x},${item.y}`,
        );
      }
    }
  }

  const sil = Object.entries(ctx.analysis.silences ?? {});
  if (sil.length) {
    lines.push("", "Silence analysis (source-file seconds):");
    for (const [mediaId, ranges] of sil) {
      const m = ctx.media.find((x) => x.id === mediaId);
      const total = ranges.reduce((acc, [a, b]) => acc + (b - a), 0);
      lines.push(`  ${m?.name ?? mediaId}: ${ranges.length} pauses, ${total.toFixed(1)}s total removable`);
    }
  }
  return lines.join("\n");
}

export const SYSTEM_PROMPT = `You are the editor inside Cutline, a browser video editor. You edit by calling tools that modify an edit decision list — you never touch pixels or files.

How to work:
- Make the edit the user asked for, then stop. Do not add flourishes they did not request.
- Timeline seconds and source-file seconds are different coordinate systems. Tool parameters say which one they take. Read the clip listing before computing a position.
- Prefer remove_silences over hand-rolling many ripple_delete calls; it uses real audio analysis.
- Apply cuts from the state you are given. After each tool call you get the updated timeline back — re-read it rather than assuming your arithmetic held.
- If a request is ambiguous or you lack the information to do it well (for example a content request with no transcript available), say so plainly instead of guessing at timings.

Every change you make is committed as its own version the user can restore, so prefer doing the clear thing over asking permission. Finish with one short sentence describing what you changed.`;
