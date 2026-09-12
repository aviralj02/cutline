import { describe, expect, test } from "bun:test";
import { emptyEdl } from "../src/lib/edl/types";
import { addEffect, addSound, addTrack, insertClip, makeEffect, splitAt, trackFor, trimClipEdge } from "../src/lib/edl/ops";
import { soundsOf } from "../src/lib/edl/query";
import { snapInterval, snapPoints, snapTo } from "../src/lib/edl/snap";

const base = () => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 20 }); // a 20s edit
const withFade = (at: number, dur = 1) => {
  const e = addTrack(base(), "fade");
  return addEffect(e, trackFor(e, "fade")!.id, { ...makeEffect("fade", at, dur), dur });
};

describe("what a drag can catch on", () => {
  test("the two ends of the edit, always", () => {
    expect(snapPoints(base())).toEqual([0, 20]);
  });

  test("a cut, so a lane can line up with it", () => {
    expect(snapPoints(splitAt(base(), 8))).toEqual([0, 8, 20]);
  });

  test("both edges of a gap", () => {
    let e = splitAt(base(), 8);
    e = trimClipEdge(e, e.clips[0].id, "end", 5);
    expect(snapPoints(e)).toEqual([0, 5, 8, 20]);
  });

  test("another lane's items, so lanes line up with each other", () => {
    expect(snapPoints(withFade(6, 2))).toEqual([0, 6, 8, 20]);
  });

  test("the playhead, when it is offered", () => {
    expect(snapPoints(base(), { extra: [3.5] })).toEqual([0, 3.5, 20]);
  });

  test("but never the item being dragged", () => {
    const e = withFade(6, 2);
    const fade = trackFor(e, "fade")!.items[0];
    expect(snapPoints(e, { exceptId: fade.id })).toEqual([0, 20]);
  });

  test("a sound's own edges are offered to everything else", () => {
    const e = addSound(base(), { src: "s1", srcDur: 60, at: 4 });
    expect(snapPoints(e)).toContain(4);
    expect(snapPoints(e, { exceptId: soundsOf(e)[0].id })).not.toContain(4);
  });
});

describe("catching", () => {
  const points = [0, 8, 20];

  test("a time just short of a cut lands exactly on it", () => {
    expect(snapTo(7.94, points, 0.1)).toEqual({ t: 8, hit: 8 });
  });

  test("and just past it, too", () => {
    expect(snapTo(8.05, points, 0.1)).toEqual({ t: 8, hit: 8 });
  });

  test("a time nowhere near one is left alone", () => {
    expect(snapTo(12, points, 0.1)).toEqual({ t: 12, hit: null });
  });

  test("the nearest wins when two are in range", () => {
    expect(snapTo(0.9, [0, 1, 8], 1).t).toBe(1);
  });
});

describe("moving a whole item", () => {
  const points = [0, 8, 20];

  test("its head catches the cut, and it keeps its length", () => {
    expect(snapInterval(7.95, 2, points, 0.1)).toEqual({ at: 8, hit: 8 });
  });

  test("its tail catches the cut, so the item ends on it", () => {
    expect(snapInterval(6.05, 2, points, 0.1)).toEqual({ at: 6, hit: 8 });
  });

  test("whichever edge is nearer wins", () => {
    // Head is 0.08 from the cut at 8; tail is 0.02 from the end at 20.
    const caught = snapInterval(7.92, 12.06, points, 0.1);
    expect(caught.hit).toBe(20);
    expect(caught.at).toBeCloseTo(7.94, 6);
  });

  test("out of range, it stays exactly where it was dragged", () => {
    expect(snapInterval(12, 2, points, 0.1)).toEqual({ at: 12, hit: null });
  });
});
