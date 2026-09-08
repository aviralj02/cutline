import { expect, test, describe } from "bun:test";
import { emptyEdl, type Edl } from "../src/lib/edl/types";
import { duration, fadeAt, tracksOf, zoomAt, envelope } from "../src/lib/edl/query";
import {
  addEffect, addTrack, insertClip, makeEffect, moveEffect, removeEffect,
  removeTrack, rippleDelete, trimEffect, updateEffect, findEffect, FADE_COLORS,
} from "../src/lib/edl/ops";

const base = (): Edl => insertClip(emptyEdl(30, 1920, 1080), { src: "m1", in: 0, out: 60 });

/** A 60s clip with one fade and one zoom lane. */
function rigged() {
  let e = addTrack(addTrack(base(), "fade"), "zoom");
  const [fadeT, zoomT] = tracksOf(e);
  e = addEffect(e, fadeT.id, { ...makeEffect("fade", 10, 2), mode: "out", color: "#000000" } as never);
  e = addEffect(e, zoomT.id, { ...makeEffect("zoom", 30, 6), scale: 2, x: 0.25, y: 0.25, ramp: 1 } as never);
  return e;
}

describe("tracks", () => {
  test("there is at most one lane per kind", () => {
    const once = addTrack(base(), "fade");
    const twice = addTrack(once, "fade");
    expect(tracksOf(twice).map((t) => t.name)).toEqual(["Fade"]);
    // Adding an existing lane returns the same document, so it never shows
    // up in the version history as a change.
    expect(twice).toBe(once);
  });

  test("lanes are ordered fade under zoom, matching compositing", () => {
    const e = addTrack(addTrack(base(), "zoom"), "fade");
    expect(tracksOf(e).map((t) => t.kind)).toEqual(["fade", "zoom"]);
  });

  test("no lanes and an empty lane list are the same document", () => {
    const one = addTrack(base(), "fade");
    expect(tracksOf(one).length).toBe(1);
    expect(removeTrack(one, tracksOf(one)[0].id).tracks).toBeUndefined();
  });

  test("removing a lane takes its effects with it", () => {
    const e = rigged();
    const gone = removeTrack(e, tracksOf(e)[0].id);
    expect(tracksOf(gone).length).toBe(1);
    expect(fadeAt(gone, 11)).toBeNull();
  });

  test("lanes do not affect timeline duration", () => {
    expect(duration(rigged())).toBe(duration(base()));
  });
});

describe("fade", () => {
  const f = (t: number) => fadeAt(rigged(), t);

  test("is inert outside its interval", () => {
    expect(f(9.9)).toBeNull();
    expect(f(12.1)).toBeNull();
  });

  test("fade out closes to the colour", () => {
    expect(f(10.1)!.alpha).toBeLessThan(0.2);
    expect(f(11.9)!.alpha).toBeGreaterThan(0.8);
    expect(f(11)!.alpha).toBeCloseTo(0.5, 1);
    expect(f(11)!.color).toBe("#000000");
  });

  test("fade in opens from the colour", () => {
    let e = addTrack(base(), "fade");
    const t = tracksOf(e)[0];
    e = addEffect(e, t.id, { ...makeEffect("fade", 5, 2), mode: "in", color: "#ffffff" } as never);
    expect(fadeAt(e, 5.1)!.alpha).toBeGreaterThan(0.8);
    expect(fadeAt(e, 6.9)!.alpha).toBeLessThan(0.2);
    expect(fadeAt(e, 5.1)!.color).toBe("#ffffff");
  });

  test("dip goes through the colour and back", () => {
    let e = addTrack(base(), "fade");
    const t = tracksOf(e)[0];
    e = addEffect(e, t.id, { ...makeEffect("fade", 20, 4), mode: "dip" } as never);
    expect(fadeAt(e, 20.2)!.alpha).toBeLessThan(0.2);
    expect(fadeAt(e, 22)!.alpha).toBeCloseTo(1, 1);
    expect(fadeAt(e, 23.8)!.alpha).toBeLessThan(0.2);
  });

  test("every palette colour is a valid hex", () => {
    for (const c of FADE_COLORS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(FADE_COLORS.map((c) => c.value)).size).toBe(FADE_COLORS.length);
  });
});

describe("zoom", () => {
  const z = (t: number) => zoomAt(rigged(), t);

  test("is inert outside its interval", () => {
    expect(z(29.9)).toBeNull();
    expect(z(36.1)).toBeNull();
  });

  test("holds full scale through the middle", () => {
    expect(z(33)!.scale).toBeCloseTo(2, 2);
    expect(z(33)!.x).toBe(0.25);
  });

  test("eases in and out rather than snapping", () => {
    const early = z(30.3)!.scale;
    const mid = z(33)!.scale;
    expect(early).toBeGreaterThan(1);
    expect(early).toBeLessThan(mid);
    expect(z(35.7)!.scale).toBeLessThan(mid);
  });

  test("a scale of 1 is not a zoom", () => {
    let e = addTrack(base(), "zoom");
    const t = tracksOf(e)[0];
    e = addEffect(e, t.id, { ...makeEffect("zoom", 5, 3), scale: 1 } as never);
    expect(zoomAt(e, 6)).toBeNull();
  });

  test("envelope is symmetric and clamped", () => {
    const item = { at: 0, dur: 10 };
    expect(envelope(item, -1, 1)).toBe(0);
    expect(envelope(item, 11, 1)).toBe(0);
    expect(envelope(item, 5, 1)).toBe(1);
    expect(envelope(item, 0.5, 1)).toBeCloseTo(envelope(item, 9.5, 1), 4);
  });

  test("a ramp longer than the effect still resolves", () => {
    const item = { at: 0, dur: 1 };
    for (const t of [0.1, 0.5, 0.9]) {
      const v = envelope(item, t, 10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("editing effects", () => {
  test("move keeps the length", () => {
    const e = rigged();
    const id = tracksOf(e)[0].items[0].id;
    const moved = moveEffect(e, id, 40);
    const item = findEffect(moved, id)!;
    expect(item.at).toBe(40);
    expect(item.dur).toBe(2);
  });

  test("move cannot go negative", () => {
    const e = rigged();
    const id = tracksOf(e)[0].items[0].id;
    expect(findEffect(moveEffect(e, id, -5), id)!.at).toBe(0);
  });

  test("trimming the start holds the end still", () => {
    const e = rigged();
    const id = tracksOf(e)[0].items[0].id; // 10 to 12
    const t = findEffect(trimEffect(e, id, "start", 11), id)!;
    expect(t.at).toBe(11);
    expect(t.at + t.dur).toBeCloseTo(12, 3);
  });

  test("trimming the end holds the start still", () => {
    const e = rigged();
    const id = tracksOf(e)[0].items[0].id;
    const t = findEffect(trimEffect(e, id, "end", 15), id)!;
    expect(t.at).toBe(10);
    expect(t.dur).toBeCloseTo(5, 3);
  });

  test("a trim cannot invert the interval", () => {
    const e = rigged();
    const id = tracksOf(e)[0].items[0].id;
    const a = findEffect(trimEffect(e, id, "start", 99), id)!;
    expect(a.dur).toBeGreaterThan(0);
    const b = findEffect(trimEffect(e, id, "end", 0), id)!;
    expect(b.dur).toBeGreaterThan(0);
  });

  test("update changes only the named fields", () => {
    const e = rigged();
    const id = tracksOf(e)[1].items[0].id;
    const next = findEffect(updateEffect(e, id, { scale: 3 } as never), id)!;
    expect(next.kind).toBe("zoom");
    expect((next as { scale: number }).scale).toBe(3);
    expect(next.at).toBe(30);
  });

  test("remove takes only that effect", () => {
    const e = rigged();
    const id = tracksOf(e)[0].items[0].id;
    const gone = removeEffect(e, id);
    expect(findEffect(gone, id)).toBeNull();
    expect(tracksOf(gone)[1].items.length).toBe(1);
  });

  test("effects survive a cut to the video track", () => {
    const e = rippleDelete(rigged(), 0, 5);
    expect(tracksOf(e)[0].items.length).toBe(1);
    expect(duration(e)).toBe(55);
  });

  test("frame snapping keeps lanes deterministic", () => {
    let a = addTrack(base(), "fade");
    const t = tracksOf(a)[0];
    const x = addEffect(a, t.id, { ...makeEffect("fade", 10.0031, 2.0007) } as never);
    const y = addEffect(a, t.id, { ...makeEffect("fade", 10.0029, 2.0011) } as never);
    const strip = (e: Edl) => JSON.stringify(e, (k, v) => (k === "id" ? undefined : v));
    expect(strip(x)).toBe(strip(y));
  });
});
