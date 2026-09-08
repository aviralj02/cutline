import type Anthropic from "@anthropic-ai/sdk";
import type { Edl } from "../edl/types";
import { duration, fmt, placed, sourceRangeToTimeline } from "../edl/query";
import {
  addText, deleteClip, moveClip, removeText, rippleDelete, rippleDeleteMany,
  setSpeed, splitAt, trimClip, trimTimeline,
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
    case "remove_text":
      return done(removeText(edl, s(input.text_id)), `Removed text ${s(input.text_id)}`);
    default:
      return { edl, summary: `Unknown tool ${name}`, result: `Error: no tool named ${name}.` };
  }
}

/** A compact, readable snapshot of the edit for the model's context. */
export function describeState(edl: Edl, ctx: AgentContext): string {
  const lines: string[] = [];
  lines.push(`Timeline: ${fmt(duration(edl))}, ${edl.clips.length} clip(s), ${edl.fps}fps, ${edl.width}x${edl.height}`);

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
