import { expect, test, describe } from "bun:test";
import { emptyEdl } from "../src/lib/edl/types";
import { insertClip } from "../src/lib/edl/ops";
import { duration, resolve } from "../src/lib/edl/query";
import { applyTool, describeState, TOOLS, type AgentContext } from "../src/lib/agent/tools";

const ctx: AgentContext = {
  media: [{ id: "m1", name: "interview.mp4", duration: 60 }],
  // Raw, unpadded detections, exactly as the client stores them.
  analysis: { silences: { m1: [[10, 13], [30, 30.4], [45, 50]] } },
};
const base = () => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 60 });

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

  test("add_text places an overlay", () => {
    const { edl } = applyTool(base(), ctx, "add_text", {
      at: 2, dur: 3, content: "Intro", style: "title",
    });
    expect(edl.text[0]).toMatchObject({ at: 2, dur: 3, content: "Intro", style: "title" });
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
