import { expect, test, describe } from "bun:test";
import { emptyEdl } from "../src/lib/edl/types";
import { insertClip, splitAt, trimClipEdge } from "../src/lib/edl/ops";
import { duration, fadeAt, isCropped, outputSize, resolve, tracksOf, zoomAt } from "../src/lib/edl/query";
import { applyTool, describeState, TOOLS, type AgentContext } from "../src/lib/agent/tools";

const ctx: AgentContext = {
  media: [{ id: "m1", name: "interview.mp4", duration: 60 }],
  // Raw, unpadded detections, exactly as the client stores them.
  analysis: { silences: { m1: [[10, 13], [30, 30.4], [45, 50]] } },
};
const base = () => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 60 });
const wide = () => insertClip(emptyEdl(30, 1920, 1080), { src: "m1", in: 0, out: 60 });

describe("tool schemas", () => {
  test("every tool is strict with a closed schema", () => {
    for (const t of TOOLS) {
      expect(t.strict).toBe(true);
      expect((t.input_schema as Record<string, unknown>).additionalProperties).toBe(false);
      expect(t.description!.length).toBeGreaterThan(20);
    }
  });
});

describe("remove_silences", () => {
  test("cuts the analysed pauses and reports the saving", () => {
    const { edl, summary } = applyTool(base(), ctx, "remove_silences", {});
    // 3s + 5s removable at default padding 0.08 (the 0.4s pause is under
    // min_silence 0.35 after padding, and is filtered by length first).
    expect(duration(edl)).toBeLessThan(53);
    expect(duration(edl)).toBeGreaterThan(51);
    expect(summary).toContain("Removed");
  });

  test("min_silence is respected", () => {
    // Only the 5s pause clears a 4s threshold; padding keeps 0.08 each side.
    const strict = applyTool(base(), ctx, "remove_silences", { min_silence: 4 });
    expect(duration(strict.edl)).toBeCloseTo(60 - 4.84, 1);
    // At the default threshold all three pauses qualify, so more comes out.
    const loose = applyTool(base(), ctx, "remove_silences", {});
    expect(duration(loose.edl)).toBeLessThan(duration(strict.edl));
  });

  test("padding leaves a margin", () => {
    const none = applyTool(base(), ctx, "remove_silences", { padding: 0 }).edl;
    const padded = applyTool(base(), ctx, "remove_silences", { padding: 0.3 }).edl;
    expect(duration(padded)).toBeGreaterThan(duration(none));
  });

  test("is idempotent — running twice does not double-cut", () => {
    const once = applyTool(base(), ctx, "remove_silences", {}).edl;
    const twice = applyTool(once, ctx, "remove_silences", {}).edl;
    // The source ranges no longer map onto the timeline, so nothing is left.
    expect(duration(twice)).toBeCloseTo(duration(once), 1);
  });

  test("no analysis means no edit, not a crash", () => {
    const empty: AgentContext = { media: [], analysis: { silences: {} } };
    const r = applyTool(base(), empty, "remove_silences", {});
    expect(duration(r.edl)).toBe(60);
    expect(r.summary).toContain("No removable silence");
  });

  test("survives a prior cut — source ranges remap onto the new timeline", () => {
    const trimmed = applyTool(base(), ctx, "ripple_delete", { start: 0, end: 20 }).edl;
    const r = applyTool(trimmed, ctx, "remove_silences", {});
    // 10-13 went with the head. 30-30.4 and 45-50 remain and still map onto
    // the shifted timeline: 0.24 + 4.84 removed from 40s.
    expect(duration(r.edl)).toBeCloseTo(40 - 5.08, 0);
    expect(resolve(r.edl, 0)!.sourceTime).toBe(20);
  });
});

describe("editing tools", () => {
  test("ripple_delete uses timeline coordinates", () => {
    const { edl } = applyTool(base(), ctx, "ripple_delete", { start: 10, end: 20 });
    expect(duration(edl)).toBe(50);
    expect(resolve(edl, 10)!.sourceTime).toBe(20);
  });

  test("trim_timeline keeps a window", () => {
    const { edl } = applyTool(base(), ctx, "trim_timeline", { start: 5, end: 35 });
    expect(duration(edl)).toBe(30);
  });

  test("text is not offered to the agent while there is no manual way to edit it", () => {
    expect(TOOLS.map((t) => t.name).filter((n) => n.includes("text"))).toEqual([]);
    expect(applyTool(base(), ctx, "add_text", { at: 2, dur: 3, content: "Intro" }).result).toContain("no tool named");
  });

  test("set_speed changes timeline duration", () => {
    const b = base();
    const { edl } = applyTool(b, ctx, "set_speed", { clip_id: b.clips[0].id, rate: 2 });
    expect(duration(edl)).toBe(30);
  });

  test("missing numeric args fall back instead of producing NaN", () => {
    const { edl } = applyTool(base(), ctx, "ripple_delete", {});
    expect(Number.isFinite(duration(edl))).toBe(true);
    expect(duration(edl)).toBe(60);
  });

  test("a bad clip id is a no-op, not a corruption", () => {
    const { edl } = applyTool(base(), ctx, "delete_clip", { clip_id: "nope" });
    expect(duration(edl)).toBe(60);
  });

  test("an unknown tool name returns an error the model can read", () => {
    const r = applyTool(base(), ctx, "explode", {});
    expect(r.result).toContain("no tool named");
    expect(duration(r.edl)).toBe(60);
  });

  test("every tool returns the timeline state for the next turn", () => {
    const r = applyTool(base(), ctx, "ripple_delete", { start: 0, end: 10 });
    expect(r.result).toMatch(/Timeline is now .* with 1 clip/);
  });
});

describe("working from loose requests", () => {
  test("the model is told the playhead, the selection and the last change", () => {
    const b = base();
    const id = b.clips[0].id;
    const s = describeState(b, { ...ctx, playhead: 12.5, selectedId: id, lastChange: { message: "Trim clip", before: b } });
    expect(s).toContain("Playhead: 0:12.50");
    expect(s).toContain("Selected: Clip 1");
    expect(s).toContain('Last change: "Trim clip"');
  });

  test("clips are numbered the way the user sees them, with gaps named apart", () => {
    let e = splitAt(base(), 30);
    e = trimClipEdge(e, e.clips[0].id, "end", 20);
    const s = describeState(e, ctx);
    expect(s).toContain("[1] Gap");
    expect(s).toContain("[2] Clip 2");
  });

  test("undo brings back the version before the last change", () => {
    const b = base();
    const cut = applyTool(b, ctx, "ripple_delete", { start: 0, end: 10 }).edl;
    const r = applyTool(cut, { ...ctx, lastChange: { message: "Cut 0:00.00–0:10.00", before: b } }, "revert_last_change", {});
    expect(duration(r.edl)).toBe(60);
    expect(r.summary).toContain("Cut 0:00.00–0:10.00");
  });

  test("with nothing earlier, undo says so instead of changing anything", () => {
    const b = base();
    const r = applyTool(b, ctx, "revert_last_change", {});
    expect(r.result).toContain("nothing earlier");
    expect(r.edl).toBe(b);
  });

  test("close_gaps closes every gap at once", () => {
    let e = splitAt(splitAt(base(), 20), 40);
    e = trimClipEdge(e, e.clips[0].id, "end", 15);
    e = trimClipEdge(e, e.clips.at(-1)!.id, "start", 45);
    const r = applyTool(e, ctx, "close_gaps", {});
    expect(r.edl.clips.some((c) => c.src === "slug")).toBe(false);
    expect(r.summary).toContain("Closed 2 gaps");
  });

  test("a fade can be changed after it is made, and colours can be named", () => {
    const e = applyTool(wide(), ctx, "add_fade", { at: 0, dur: 1, mode: "in", color: "White" }).edl;
    const fade = tracksOf(e)[0].items[0];
    expect(fade).toMatchObject({ color: "#ffffff" });
    const r = applyTool(e, ctx, "adjust_lane_item", { item_id: fade.id, mode: "dip", color: "sepia", dur: 2 });
    expect(tracksOf(r.edl)[0].items[0]).toMatchObject({ mode: "dip", color: "#3a2a18", dur: 2 });
  });

  test("a zoom can be pushed further and eased, then removed", () => {
    const e = applyTool(wide(), ctx, "add_zoom", { at: 10, dur: 4, scale: 1.4 }).edl;
    const zoom = tracksOf(e)[0].items[0];
    const r = applyTool(e, ctx, "adjust_lane_item", { item_id: zoom.id, scale: 2, ease: 1 });
    expect(tracksOf(r.edl)[0].items[0]).toMatchObject({ scale: 2, ramp: 1 });
    expect(tracksOf(applyTool(r.edl, ctx, "remove_lane_item", { item_id: zoom.id }).edl)[0].items.length).toBe(0);
  });

  test("a field that doesn't apply is reported back, not applied", () => {
    const e = applyTool(wide(), ctx, "add_fade", { at: 0, dur: 1, mode: "in" }).edl;
    const fade = tracksOf(e)[0].items[0];
    const r = applyTool(e, ctx, "adjust_lane_item", { item_id: fade.id, volume: 0.2 });
    expect(r.result).toContain("Ignored volume");
  });

  test("clear_lane removes every zoom with its lane", () => {
    let e = applyTool(wide(), ctx, "add_zoom", { at: 10, dur: 4, scale: 1.4 }).edl;
    e = applyTool(e, ctx, "add_zoom", { at: 30, dur: 4, scale: 2 }).edl;
    expect(tracksOf(applyTool(e, ctx, "clear_lane", { kind: "zoom" }).edl).length).toBe(0);
  });
});

describe("describeState", () => {
  test("gives the model coordinates, ids and analysis", () => {
    const s = describeState(base(), ctx);
    expect(s).toContain("interview.mp4");
    expect(s).toContain("1:00.00");
    expect(s).toMatch(/id=\w+/);
    expect(s).toContain("3 pauses");
  });

  test("handles an empty timeline", () => {
    expect(describeState(emptyEdl(30), ctx)).toContain("(empty)");
  });
});

describe("reframe", () => {
  test("crops to a vertical aspect", () => {
    const { edl, summary } = applyTool(wide(), ctx, "reframe", { aspect: "9:16" });
    const out = outputSize(edl);
    expect(out.width / out.height).toBeCloseTo(9 / 16, 2);
    expect(summary).toContain("9:16");
  });

  test("reset restores the full frame", () => {
    const cropped = applyTool(wide(), ctx, "reframe", { aspect: "1:1" }).edl;
    expect(isCropped(cropped)).toBe(true);
    const back = applyTool(cropped, ctx, "reframe", { aspect: "reset" }).edl;
    expect(isCropped(back)).toBe(false);
  });

  test("an unknown aspect changes nothing and says so", () => {
    const r = applyTool(wide(), ctx, "reframe", { aspect: "3:7" });
    expect(isCropped(r.edl)).toBe(false);
    expect(r.result).toContain("unknown aspect");
  });

  test("reframing does not disturb the cuts", () => {
    const cut = applyTool(wide(), ctx, "ripple_delete", { start: 0, end: 10 }).edl;
    const framed = applyTool(cut, ctx, "reframe", { aspect: "1:1" }).edl;
    expect(duration(framed)).toBe(50);
    expect(framed.clips.length).toBe(1);
  });

  test("the model is told the output size and the crop", () => {
    const framed = applyTool(wide(), ctx, "reframe", { aspect: "9:16" }).edl;
    const s = describeState(framed, ctx);
    expect(s).toContain("output");
    expect(s).toContain("Cropped:");
  });
});

describe("effect tools", () => {
  test("add_fade creates the lane on demand", () => {
    const r = applyTool(wide(), ctx, "add_fade", { at: 0, dur: 1, mode: "in", color: "#ffffff" });
    const lanes = tracksOf(r.edl);
    expect(lanes.length).toBe(1);
    expect(lanes[0].kind).toBe("fade");
    expect(fadeAt(r.edl, 0.1)!.color).toBe("#ffffff");
    expect(r.summary).toContain("fade in");
  });

  test("a second fade reuses the same lane", () => {
    let e = applyTool(wide(), ctx, "add_fade", { at: 0, dur: 1, mode: "in" }).edl;
    e = applyTool(e, ctx, "add_fade", { at: 50, dur: 2, mode: "out" }).edl;
    expect(tracksOf(e).length).toBe(1);
    expect(tracksOf(e)[0].items.length).toBe(2);
  });

  test("a bad colour falls back to black rather than corrupting the document", () => {
    const r = applyTool(wide(), ctx, "add_fade", { at: 5, dur: 1, mode: "out", color: "red" });
    expect(fadeAt(r.edl, 5.9)!.color).toBe("#000000");
  });

  test("add_zoom creates its own lane and clamps the scale", () => {
    const r = applyTool(wide(), ctx, "add_zoom", { at: 10, dur: 4, scale: 99 });
    expect(tracksOf(r.edl)[0].kind).toBe("zoom");
    expect(zoomAt(r.edl, 12)!.scale).toBeLessThanOrEqual(4);
  });

  test("zoom focal point is clamped into the frame", () => {
    const r = applyTool(wide(), ctx, "add_zoom", { at: 10, dur: 4, scale: 2, x: 5, y: -3 });
    const z = zoomAt(r.edl, 12)!;
    expect(z.x).toBe(1);
    expect(z.y).toBe(0);
  });

  test("fade and zoom lanes coexist", () => {
    let e = applyTool(wide(), ctx, "add_fade", { at: 0, dur: 1, mode: "in" }).edl;
    e = applyTool(e, ctx, "add_zoom", { at: 20, dur: 4, scale: 1.5 }).edl;
    expect(tracksOf(e).map((t) => t.kind)).toEqual(["fade", "zoom"]);
    expect(fadeAt(e, 0.2)).not.toBeNull();
    expect(zoomAt(e, 22)).not.toBeNull();
  });

  test("the model is told what is on the lanes", () => {
    const e = applyTool(wide(), ctx, "add_zoom", { at: 10, dur: 4, scale: 2 }).edl;
    const s = describeState(e, ctx);
    expect(s).toContain("Effect lanes:");
    expect(s).toContain("2x");
  });

  test("effects do not disturb the cuts", () => {
    let e = applyTool(wide(), ctx, "add_fade", { at: 0, dur: 1, mode: "in" }).edl;
    e = applyTool(e, ctx, "ripple_delete", { start: 0, end: 10 }).edl;
    expect(duration(e)).toBe(50);
    expect(tracksOf(e)[0].items.length).toBe(1);
  });
});
