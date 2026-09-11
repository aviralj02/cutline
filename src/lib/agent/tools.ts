import type Anthropic from "@anthropic-ai/sdk";
import type { Edl, Effect, TrackKind } from "../edl/types";
import {
  clipCount, clipNumber, cropOf, duration, fmt, isCropped, isFade, isSlug, isSound, outputSize, placed,
  sourceRangeToTimeline, tracksOf,
} from "../edl/query";
import {
  addEffect, addTrack, deleteClip, FADE_COLORS, findEffect, makeEffect, moveClip, moveEffect,
  removeEffect, removeTrack, resetCrop, rippleDelete, rippleDeleteMany, setCropAspect, setSpeed,
  setVideoMuted, splitAt, trackFor, trimClip, trimEffect, trimTimeline, updateEffect,
} from "../edl/ops";

export interface MediaInfo {
  id: string;
  name: string;
  duration: number;
  /** A sound file for the sound lane; absent for video. */
  kind?: "sound";
}

/** What the agent knows about the footage beyond the edit itself. */
export interface Analysis {
  /** mediaId -> silence ranges in source-file seconds. */
  silences: Record<string, Array<[number, number]>>;
}

export interface AgentContext {
  media: MediaInfo[];
  analysis: Analysis;
  /** Where the user is looking, in timeline seconds: what "here" and "now" mean. */
  playhead?: number;
  /** The clip, gap or lane item the user has selected: what "this" and "it" mean. */
  selectedId?: string | null;
  /** The newest version's message and the document before it, so "undo" can be done. */
  lastChange?: { message: string; before: Edl };
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties: props,
  required,
  additionalProperties: false,
});

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const COLOR_NAMES = FADE_COLORS.map((c) => c.name).join(", ");

/** Every manual action has a tool, and each is a pure function over the document, so a bad call is only a version to undo. */
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
      "Delete a timeline range and close the space it leaves. Times are timeline seconds, not source-file seconds. Use for 'cut from 0:10 to 0:15' or 'drop the first 5 seconds'.",
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
    description:
      "Split the clip at a timeline position into two clips. Does not remove anything. For 'split here', use the playhead.",
    strict: true,
    input_schema: obj({ at: num("Timeline seconds.") }, ["at"]),
  },
  {
    name: "delete_clip",
    description: "Remove one clip by id and close the space it leaves. Given a gap's id, closes that gap.",
    strict: true,
    input_schema: obj({ clip_id: str("Clip id from the timeline listing.") }, ["clip_id"]),
  },
  {
    name: "trim_clip",
    description:
      "Change which part of its source file a clip plays. Times are seconds into the SOURCE file. The clips after it move to follow, so the track stays back to back.",
    strict: true,
    input_schema: obj(
      { clip_id: str("Clip id."), in: num("Source seconds."), out: num("Source seconds.") },
      ["clip_id"],
    ),
  },
  {
    name: "move_clip",
    description:
      "Reorder a clip. to_index is the [index] from the clip listing, where gaps count as entries too.",
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
    name: "close_gaps",
    description:
      "Close every gap on the video track, so the clips play back to back. Use for 'remove the black bits', 'close the gaps' or 'no empty space'.",
    strict: true,
    input_schema: obj({}, []),
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
        color: str(`Hex such as #000000, or a name: ${COLOR_NAMES}. Defaults to black.`),
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
    name: "adjust_lane_item",
    description:
      "Change a fade, zoom or sound already on the lanes, by its id from the lane listing. at and dur work on all three; mode and color only on a fade; scale, x, y and ease only on a zoom; volume only on a sound. Use for 'make the fade longer', 'zoom in more', 'move the music to 5 seconds' or 'make the music quieter'.",
    strict: true,
    input_schema: obj(
      {
        item_id: str("Id from the lane listing."),
        at: num("New start, in timeline seconds."),
        dur: num("New length in seconds. A sound can't run past the end of its file."),
        mode: { type: "string", enum: ["in", "out", "dip"], description: "Fade only." },
        color: str(`Fade only. Hex such as #ffffff, or a name: ${COLOR_NAMES}.`),
        scale: num("Zoom only. 1 to 4."),
        x: num("Zoom only. Focal point across the frame, 0 to 1."),
        y: num("Zoom only. Focal point down the frame, 0 to 1."),
        ease: num("Zoom only. Seconds spent easing in and out, 0 to 5."),
        volume: num("Sound only. 0 to 1; 1 is the file's own level."),
      },
      ["item_id"],
    ),
  },
  {
    name: "remove_lane_item",
    description:
      "Remove one fade, zoom or sound from the lanes by its id. Use for 'remove that zoom', 'delete the fade' or 'take the music off'.",
    strict: true,
    input_schema: obj({ item_id: str("Id from the lane listing.") }, ["item_id"]),
  },
  {
    name: "clear_lane",
    description:
      "Remove every fade, every zoom or every sound at once, together with its lane. Use for 'remove all the zooms' or 'no music at all'.",
    strict: true,
    input_schema: obj(
      { kind: { type: "string", enum: ["fade", "zoom", "sound"], description: "Which lane to clear." } },
      ["kind"],
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
    name: "set_original_audio",
    description:
      "Mute or unmute the sound recorded with the video, for the whole edit. Sound lanes keep playing. Use for 'mute the original audio' or 'only play the music'.",
    strict: true,
    input_schema: obj(
      { muted: { type: "boolean", description: "True turns the video's own sound off." } },
      ["muted"],
    ),
  },
  {
    name: "revert_last_change",
    description:
      "Undo the most recent change to the edit, whoever made it, by bringing back the version before it. Anything else done in this request is discarded with it. Use for 'undo', 'go back', 'put it back' or 'that's wrong'. The listing names the last change.",
    strict: true,
    input_schema: obj({}, []),
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
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A fade colour from a hex code or one of the palette's names; null if it is neither. */
function colorOf(v: unknown): string | null {
  const x = s(v).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(x)) return x;
  return FADE_COLORS.find((c) => c.name.toLowerCase() === x)?.value ?? null;
}
const colorName = (hex: string) => FADE_COLORS.find((c) => c.value === hex)?.name.toLowerCase() ?? hex;

/** Execute one tool call. Pure: same input, same output, no I/O. */
export function applyTool(edl: Edl, ctx: AgentContext, name: string, input: Input): ToolOutcome {
  const before = duration(edl);
  const done = (next: Edl, summary: string): ToolOutcome => ({
    edl: next,
    summary,
    result: `${summary}. Timeline is now ${fmt(duration(next))} with ${clipCount(next)} clip(s).`,
  });
  const fail = (summary: string, why: string): ToolOutcome => ({ edl, summary, result: `Error: ${why}` });

  switch (name) {
    case "remove_silences": {
      const minSilence = n(input.min_silence, 0.35);
      const padding = n(input.padding, 0.08);
      const ranges: Array<[number, number]> = [];
      for (const [mediaId, list] of Object.entries(ctx.analysis.silences ?? {})) {
        for (const [a, b] of list) {
          // Detections are stored raw: filter, then pad, then map source time onto the timeline.
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
    case "close_gaps": {
      let next = edl;
      let count = 0;
      for (let gap = next.clips.find(isSlug); gap && count < 1000; gap = next.clips.find(isSlug)) {
        next = deleteClip(next, gap.id);
        count++;
      }
      if (!count) return done(edl, "There were no gaps to close");
      return done(next, `Closed ${count} gap${count > 1 ? "s" : ""} (−${(before - duration(next)).toFixed(1)}s)`);
    }
    case "add_fade": {
      const at = n(input.at);
      const dur = Math.max(0.08, n(input.dur, 1));
      const mode = s(input.mode, "out") as "in" | "out" | "dip";
      const color = colorOf(input.color) ?? "#000000";
      // The lane is made on demand, so the model never sequences a setup call first.
      const withLane = trackFor(edl, "fade") ? edl : addTrack(edl, "fade");
      const lane = trackFor(withLane, "fade")!;
      const item = { ...makeEffect("fade", at, dur), dur, mode, color } as never;
      return done(
        addEffect(withLane, lane.id, item),
        `Added a ${mode === "dip" ? "dip through" : `fade ${mode}`} ${colorName(color)} at ${fmt(at)}`,
      );
    }
    case "add_zoom": {
      const at = n(input.at);
      const dur = Math.max(0.24, n(input.dur, 2));
      const scale = clamp(n(input.scale, 1.4), 1, 4);
      const withLane = trackFor(edl, "zoom") ? edl : addTrack(edl, "zoom");
      const lane = trackFor(withLane, "zoom")!;
      const item = {
        ...makeEffect("zoom", at, dur),
        dur,
        scale,
        x: clamp(n(input.x, 0.5), 0, 1),
        y: clamp(n(input.y, 0.45), 0, 1),
      } as never;
      return done(addEffect(withLane, lane.id, item), `Added a ${scale.toFixed(2)}× zoom at ${fmt(at)}`);
    }
    case "adjust_lane_item": {
      const iid = s(input.item_id);
      const item = findEffect(edl, iid);
      if (!item) return fail(`Nothing with id ${iid}`, `nothing on the lanes has id ${iid}.`);
      let next = edl;
      const said: string[] = [];
      const ignored: string[] = [];
      // A field for another kind is reported back rather than silently dropped.
      const given = (key: string, kind: Effect["kind"]) => {
        if (input[key] === undefined) return false;
        if (item.kind !== kind) ignored.push(key);
        return item.kind === kind;
      };
      if (input.at !== undefined) {
        next = moveEffect(next, iid, n(input.at, item.at));
        said.push(`moved to ${fmt(findEffect(next, iid)!.at)}`);
      }
      if (input.dur !== undefined) {
        const cur = findEffect(next, iid)!;
        next = trimEffect(next, iid, "end", cur.at + n(input.dur, cur.dur));
        said.push(`${findEffect(next, iid)!.dur.toFixed(1)}s long`);
      }
      const patch: Record<string, unknown> = {};
      if (given("mode", "fade") && ["in", "out", "dip"].includes(s(input.mode))) {
        patch.mode = input.mode;
        said.push(input.mode === "dip" ? "dipping through" : `fading ${input.mode}`);
      }
      if (given("color", "fade")) {
        const color = colorOf(input.color);
        if (color) {
          patch.color = color;
          said.push(`to ${colorName(color)}`);
        } else ignored.push("color");
      }
      if (given("scale", "zoom")) {
        patch.scale = clamp(n(input.scale, 1.4), 1, 4);
        said.push(`${(patch.scale as number).toFixed(2)}×`);
      }
      if (given("x", "zoom")) patch.x = clamp(n(input.x, 0.5), 0, 1);
      if (given("y", "zoom")) patch.y = clamp(n(input.y, 0.45), 0, 1);
      if ("x" in patch || "y" in patch) said.push("focus moved");
      if (given("ease", "zoom")) {
        patch.ramp = clamp(n(input.ease, 0.4), 0, 5);
        said.push(`easing ${(patch.ramp as number).toFixed(2)}s`);
      }
      if (given("volume", "sound")) {
        patch.volume = clamp(n(input.volume, 1), 0, 1);
        said.push(`at ${Math.round((patch.volume as number) * 100)}% volume`);
      }
      if (Object.keys(patch).length) next = updateEffect(next, iid, patch as Partial<Effect>);
      const kind = item.kind[0].toUpperCase() + item.kind.slice(1);
      const out = done(next, said.length ? `${kind} ${said.join(", ")}` : `Left the ${item.kind} as it was`);
      if (ignored.length) out.result += ` Ignored ${ignored.join(", ")}: not something a ${item.kind} has.`;
      return out;
    }
    case "remove_lane_item": {
      const iid = s(input.item_id);
      const item = findEffect(edl, iid);
      if (!item) return fail(`Nothing with id ${iid}`, `nothing on the lanes has id ${iid}.`);
      return done(removeEffect(edl, iid), `Removed the ${item.kind} at ${fmt(item.at)}`);
    }
    case "clear_lane": {
      const kind = s(input.kind) as TrackKind;
      const lane = ["fade", "zoom", "sound"].includes(kind) ? trackFor(edl, kind) : null;
      if (!lane) return done(edl, `There was no ${kind || "such"} lane to clear`);
      return done(removeTrack(edl, lane.id), `Removed the ${lane.name.toLowerCase()} lane and everything on it`);
    }
    case "reframe": {
      const key = s(input.aspect, "reset");
      if (key === "reset") return done(resetCrop(edl), "Restored the full frame");
      const ratios: Record<string, number> = {
        "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5, "4:3": 4 / 3,
      };
      const aspect = ratios[key];
      if (!aspect) return fail(`Unknown aspect ${key}`, `unknown aspect ${key}.`);
      const next = setCropAspect(edl, aspect);
      const size = outputSize(next);
      return done(next, `Reframed to ${key} (${size.width} × ${size.height})`);
    }
    case "set_original_audio": {
      const muted = input.muted === true;
      return done(setVideoMuted(edl, muted), muted ? "Muted the original audio" : "Turned the original audio back on");
    }
    case "revert_last_change": {
      const last = ctx.lastChange;
      if (!last) return fail("Nothing to go back to", "this is the first version; there is nothing earlier to go back to.");
      return done(last.before, `Went back to before “${last.message}”`);
    }
    default:
      return fail(`Unknown tool ${name}`, `no tool named ${name}.`);
  }
}

/** A compact, readable snapshot of the edit for the model's context. */
export function describeState(edl: Edl, ctx: AgentContext): string {
  const lines: string[] = [];
  const size = outputSize(edl);
  lines.push(`Timeline: ${fmt(duration(edl))}, ${clipCount(edl)} clip(s), ${edl.fps}fps`);
  lines.push(`Frame: source ${edl.width}x${edl.height}, output ${size.width}x${size.height}`);
  if (isCropped(edl)) {
    const c = cropOf(edl);
    lines.push(`Cropped: x=${c.x} y=${c.y} w=${c.w} h=${c.h} of the frame`);
  }
  if (edl.videoMuted) lines.push("Original audio: muted (sound lanes still play)");

  // What loose requests point at: "here", "this", "undo".
  if (ctx.playhead !== undefined) lines.push(`Playhead: ${fmt(ctx.playhead)} ("here" and "now" mean this point)`);
  if (ctx.selectedId) {
    const clip = edl.clips.find((c) => c.id === ctx.selectedId);
    const item = clip ? null : findEffect(edl, ctx.selectedId);
    const label = clip
      ? isSlug(clip)
        ? `a gap (id=${clip.id})`
        : `Clip ${clipNumber(edl, clip.id)} (id=${clip.id})`
      : item
        ? `the ${item.kind} at ${fmt(item.at)} (id=${item.id})`
        : null;
    if (label) lines.push(`Selected: ${label} ("this" and "it" mean this)`);
  }
  if (ctx.lastChange) lines.push(`Last change: "${ctx.lastChange.message}" (revert_last_change undoes it)`);

  lines.push("", "Clips ([index] name | timeline position | source range). Users number clips as shown, not by index:");
  for (const p of placed(edl)) {
    if (isSlug(p.clip)) {
      lines.push(`  [${p.index}] Gap id=${p.clip.id} ${fmt(p.start)}–${fmt(p.end)} | plays as black`);
      continue;
    }
    const m = ctx.media.find((x) => x.id === p.clip.src);
    const speed = p.clip.speed && p.clip.speed !== 1 ? ` ${p.clip.speed}x` : "";
    lines.push(
      `  [${p.index}] Clip ${clipNumber(edl, p.clip.id)} id=${p.clip.id} ${fmt(p.start)}–${fmt(p.end)} | ${m?.name ?? p.clip.src} ${fmt(p.clip.in)}–${fmt(p.clip.out)}${speed}`,
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
        const head = `  ${lane.name} id=${item.id} ${fmt(item.at)} +${item.dur}s`;
        lines.push(
          isFade(item)
            ? `${head} ${item.mode} ${item.color}`
            : isSound(item)
              ? `${head} ${ctx.media.find((m) => m.id === item.src)?.name ?? item.src} from ${fmt(item.in)} at ${Math.round(item.volume * 100)}%`
              : `${head} ${item.scale}x at ${item.x},${item.y}, easing ${item.ramp}s`,
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

export const SYSTEM_PROMPT = `You are the editor inside Cutline, a browser video editor. You edit by calling tools that change an edit decision list — you never touch pixels or files.

People describe edits loosely. Work out what they want done and map it onto the tools:
- "Here" and "now" mean the playhead. "This" and "it" mean the selection. Both are in the listing.
- "Clip 2" or "the second clip" means Clip 2 as numbered in the listing; use its id.
- "The music", "the song" or "background audio" means the sound lane; "louder" and "quieter" are its volume.
- "Mute", "no sound" or "only the music" means set_original_audio.
- "Undo", "go back" or "that's wrong" means revert_last_change.
- "Remove the black bits" or "close the gaps" means close_gaps.
- "Tighten it up", "cut the pauses" or "remove dead air" means remove_silences.
- "Vertical", "for TikTok, Reels or Shorts" means reframe 9:16; "square" means 1:1.

How to work:
- Make the edit asked for, then stop. Do not add flourishes nobody asked for.
- Timeline seconds and source-file seconds are different; each tool parameter says which it takes. Read the listing before computing a position, and re-read the state each tool returns rather than trusting your arithmetic.
- When a request is vague but a reasonable edit exists, make it and say in one sentence what you assumed. Every change is a version the user can undo, so a sensible guess beats a question. Ask only when there is no reasonable reading.
- You cannot add files or text. For music, tell the user to use Add sound under the timeline; for more video, the add-video button on the Video lane.
- Requests about what is said ("cut the part about pricing") need a transcript Cutline does not have yet. Say so plainly rather than guessing at timings.

Finish with one short sentence describing what you changed.`;
