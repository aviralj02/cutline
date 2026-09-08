import { expect, test, describe } from "bun:test";
import { emptyEdl, type Edl } from "../src/lib/edl/types";
import { duration, placed, resolve } from "../src/lib/edl/query";
import {
  addText, deleteClip, insertClip, moveClip, rippleDelete,
  rippleDeleteMany, setSpeed, splitAt, trimTimeline,
} from "../src/lib/edl/ops";

/** One 60s clip of "interview.mp4". */
const base = (): Edl => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 60 });

describe("placement", () => {
  test("contiguous prefix sum", () => {
    let e = base();
    e = insertClip(e, { src: "m1", in: 100, out: 110 });
    const p = placed(e);
    expect(p.map((x) => [x.start, x.end])).toEqual([[0, 60], [60, 70]]);
    expect(duration(e)).toBe(70);
  });

  test("speed compresses timeline duration", () => {
    const b = base();
    const e = setSpeed(b, b.clips[0].id, 2);
    expect(duration(e)).toBe(30);
    expect(resolve(e, 10)!.sourceTime).toBe(20);
  });
});

describe("rippleDelete", () => {
  test("interior cut splits and closes the gap", () => {
    const e = rippleDelete(base(), 10, 20);
    expect(duration(e)).toBe(50);
    expect(e.clips.length).toBe(2);
    expect(resolve(e, 9)!.sourceTime).toBe(9);
    expect(resolve(e, 10)!.sourceTime).toBe(20); // 10..20 is gone
  });

  test("head cut", () => {
    const e = rippleDelete(base(), 0, 5);
    expect(duration(e)).toBe(55);
    expect(resolve(e, 0)!.sourceTime).toBe(5);
  });

  test("tail cut", () => {
    const e = rippleDelete(base(), 55, 999);
    expect(duration(e)).toBe(55);
  });

  test("swallows whole clips and spans boundaries", () => {
    let e = base();
    e = insertClip(e, { src: "m2", in: 0, out: 10 });
    e = insertClip(e, { src: "m3", in: 0, out: 10 }); // 0-60, 60-70, 70-80
    e = rippleDelete(e, 55, 75);
    expect(duration(e)).toBe(60);
    expect(e.clips.map((c) => c.src)).toEqual(["m1", "m3"]);
    expect(e.clips[1].in).toBe(5);
  });

  test("empty and inverted ranges are no-ops", () => {
    const e = base();
    expect(rippleDelete(e, 10, 10)).toEqual(e);
    expect(rippleDelete(e, 20, 10)).toEqual(e);
  });

  test("clip ids stay unique after a split", () => {
    const e = rippleDelete(base(), 10, 20);
    expect(new Set(e.clips.map((c) => c.id)).size).toBe(e.clips.length);
  });
});

describe("rippleDeleteMany", () => {
  test("removes every range measured against the original timeline", () => {
    // Three 5s silences. Order given deliberately unsorted.
    const e = rippleDeleteMany(base(), [[30, 35], [5, 10], [50, 55]]);
    expect(duration(e)).toBe(45);
    // Everything that survived must be reachable and never land in a hole.
    for (const hole of [[5, 10], [30, 35], [50, 55]]) {
      const src = placed(e).flatMap((p) =>
        [p.start, p.end - 1 / 30].map((t) => resolve(e, t)?.sourceTime ?? -1),
      );
      expect(src.some((s) => s >= hole[0] && s < hole[1])).toBe(false);
    }
  });

  test("overlapping ranges do not over-delete", () => {
    const e = rippleDeleteMany(base(), [[10, 20], [15, 25]]);
    expect(duration(e)).toBe(45); // 10..25 removed once
  });
});

describe("text overlays follow the cut", () => {
  test("overlay after a cut shifts back", () => {
    let e = addText(base(), { at: 40, dur: 3, content: "hi", style: "caption" });
    e = rippleDelete(e, 10, 20);
    expect(e.text[0].at).toBe(30);
    expect(e.text[0].dur).toBe(3);
  });

  test("overlay before a cut is untouched", () => {
    let e = addText(base(), { at: 2, dur: 3, content: "hi", style: "caption" });
    e = rippleDelete(e, 10, 20);
    expect(e.text[0].at).toBe(2);
  });

  test("overlay straddling a cut is shortened, not moved", () => {
    let e = addText(base(), { at: 8, dur: 8, content: "hi", style: "caption" }); // 8..16
    e = rippleDelete(e, 10, 20);
    expect(e.text[0].at).toBe(8);
    expect(e.text[0].dur).toBe(2); // only 8..10 survives
  });

  test("overlay entirely inside a cut is dropped", () => {
    let e = addText(base(), { at: 12, dur: 3, content: "hi", style: "caption" });
    e = rippleDelete(e, 10, 20);
    expect(e.text.length).toBe(0);
  });
});

describe("other ops", () => {
  test("splitAt is lossless", () => {
    const e = splitAt(base(), 25);
    expect(e.clips.length).toBe(2);
    expect(duration(e)).toBe(60);
  });

  test("splitAt on a boundary does nothing", () => {
    expect(splitAt(base(), 0).clips.length).toBe(1);
    expect(splitAt(base(), 60).clips.length).toBe(1);
  });

  test("deleteClip removes exactly that clip", () => {
    let e = base();
    e = insertClip(e, { src: "m2", in: 0, out: 10 });
    e = deleteClip(e, e.clips[0].id);
    expect(e.clips.map((c) => c.src)).toEqual(["m2"]);
    expect(duration(e)).toBe(10);
  });

  test("moveClip reorders", () => {
    let e = base();
    e = insertClip(e, { src: "m2", in: 0, out: 10 });
    e = moveClip(e, e.clips[1].id, 0);
    expect(e.clips.map((c) => c.src)).toEqual(["m2", "m1"]);
  });

  test("trimTimeline keeps the requested window", () => {
    const e = trimTimeline(base(), 10, 40);
    expect(duration(e)).toBe(30);
    expect(resolve(e, 0)!.sourceTime).toBe(10);
  });

  test("frame snapping keeps output deterministic", () => {
    const a = rippleDelete(base(), 10.0031, 20.0007);
    const b = rippleDelete(base(), 10.0029, 20.0011);
    const shape = (e: Edl) => JSON.stringify(e, (k, v) => (k === "id" ? undefined : v));
    expect(shape(a)).toBe(shape(b));
  });
});
