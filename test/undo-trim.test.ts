import { expect, test, describe } from "bun:test";
import { emptyEdl, type Edl } from "../src/lib/edl/types";
import { duration, isSlug, placed, resolve } from "../src/lib/edl/query";
import { deleteClip, insertClip, trimClipEdge, rippleDelete, splitAt, swapClips } from "../src/lib/edl/ops";
import * as vcs from "../src/lib/vcs/repo";

const one = (): Edl => insertClip(emptyEdl(30), { src: "m1", in: 10, out: 40 });
const two = (): Edl => insertClip(one(), { src: "m1", in: 50, out: 60 });

/** Gap lengths, in track order. */
const gaps = (e: Edl) => e.clips.filter(isSlug).map((c) => c.out - c.in);
const footage = (e: Edl, id: string) => e.clips.find((c) => c.id === id)!;

describe("trimming a clip by its edges", () => {
  test("dragging the head in moves only the head, leaving a gap before it", () => {
    const e = two(); // 0-30 then 30-40
    const id = e.clips[0].id;
    const t = trimClipEdge(e, id, "start", 5);
    expect(footage(t, id).in).toBe(15); // 10 + 5s of source
    expect(gaps(t)).toEqual([5]);
    expect(placed(t)[1].start).toBe(5); // its left edge moved right
    expect(placed(t)[1].end).toBe(30); // its right edge stayed
    expect(placed(t)[2].start).toBe(30); // the next clip did not move
    expect(duration(t)).toBe(40);
  });

  test("dragging the tail in leaves a gap after it, so the next clip stays put", () => {
    const e = two();
    const t = trimClipEdge(e, e.clips[0].id, "end", 20);
    expect(t.clips[0].out).toBe(30);
    expect(gaps(t)).toEqual([10]);
    expect(placed(t)[2].start).toBe(30);
    expect(duration(t)).toBe(40);
  });

  test("trimming the last clip's tail shortens the edit, with no gap", () => {
    const e = one();
    const t = trimClipEdge(e, e.clips[0].id, "end", 20);
    expect(duration(t)).toBe(20);
    expect(gaps(t)).toEqual([]);
  });

  test("the head cannot pass the tail", () => {
    const e = one();
    const id = e.clips[0].id;
    const t = trimClipEdge(e, id, "start", 999);
    expect(footage(t, id).in).toBeLessThan(footage(t, id).out);
    // Gap plus a two-frame clip; the sum carries float noise, the boundaries don't.
    expect(duration(t)).toBeCloseTo(30, 6);
  });

  test("the tail cannot pass the head", () => {
    const e = one();
    const t = trimClipEdge(e, e.clips[0].id, "end", -50);
    expect(t.clips[0].out).toBeGreaterThan(t.clips[0].in);
  });

  test("with nothing before it to give, a head cannot be extended", () => {
    const e = one(); // source in = 10, at the very start
    const t = trimClipEdge(e, e.clips[0].id, "start", -5);
    expect(t.clips[0].in).toBe(10);
    expect(duration(t)).toBe(30);
  });

  test("a head extends back into the gap it left, and no further", () => {
    let e = one();
    const id = e.clips[0].id;
    e = trimClipEdge(e, id, "start", 5);
    e = trimClipEdge(e, id, "start", -100);
    expect(e.clips.length).toBe(1);
    expect(e.clips[0].in).toBe(10);
    expect(resolve(e, 0)!.sourceTime).toBe(10);
  });

  test("a head cannot be extended past the start of its own footage", () => {
    // A is 0-10; B starts 2s into its file. Trimming A's tail leaves 6s of gap before B.
    let e = insertClip(insertClip(emptyEdl(30), { src: "m1", in: 0, out: 10 }), { src: "m1", in: 2, out: 40 });
    const [a, b] = e.clips.map((c) => c.id);
    e = trimClipEdge(e, a, "end", 4);
    e = trimClipEdge(e, b, "start", -100);
    expect(footage(e, b).in).toBe(0);
    expect(gaps(e)).toEqual([4]);
  });

  test("a tail is stopped by the clip after it, and extends into a gap", () => {
    let e = two();
    const a = e.clips[0].id;
    expect(trimClipEdge(e, a, "end", 35).clips[0].out).toBe(40);
    e = trimClipEdge(e, a, "end", 20);
    e = trimClipEdge(e, a, "end", 25);
    expect(e.clips[0].out).toBe(35);
    expect(gaps(e)).toEqual([5]);
  });

  test("a clip cannot be extended past the end of its own footage", () => {
    const e = one(); // source out = 40, file is 45s long
    const t = trimClipEdge(e, e.clips[0].id, "end", 999, 45);
    expect(t.clips[0].out).toBe(45);
  });

  test("speed is respected when mapping the drag to source time", () => {
    let e = insertClip(emptyEdl(30), { src: "m1", in: 0, out: 60, speed: 2 });
    // 60s of source at 2x occupies 30s of timeline.
    expect(duration(e)).toBe(30);
    e = trimClipEdge(e, e.clips[0].id, "end", 10);
    // 10s of timeline is 20s of source.
    expect(e.clips[0].out).toBe(20);
  });

  test("an unknown clip id changes nothing", () => {
    const e = one();
    expect(trimClipEdge(e, "nope", "start", 5)).toBe(e);
  });

  test("a gap has no edges of its own to drag", () => {
    const e = two();
    const t = trimClipEdge(e, e.clips[0].id, "end", 20);
    const gap = t.clips.find(isSlug)!;
    expect(trimClipEdge(t, gap.id, "start", 0)).toBe(t);
  });
});

describe("gaps", () => {
  const withGap = () => {
    const e = two(); // a is 0-30, b is 30-40
    return trimClipEdge(e, e.clips[0].id, "end", 20); // a 0-20, gap 20-30, b 30-40
  };

  test("a gap plays as nothing: no footage is under it", () => {
    expect(resolve(withGap(), 25)).toBeNull();
  });

  test("closing a gap is deleting it", () => {
    const t = withGap();
    const closed = deleteClip(t, t.clips.find(isSlug)!.id);
    expect(gaps(closed)).toEqual([]);
    expect(duration(closed)).toBe(30);
  });

  test("a gap is never left at the end", () => {
    const t = withGap();
    const done = deleteClip(t, t.clips.at(-1)!.id);
    expect(done.clips.length).toBe(1);
    expect(duration(done)).toBe(20);
  });

  test("splitting inside a gap changes nothing", () => {
    const t = withGap();
    expect(JSON.stringify(splitAt(t, 25))).toBe(JSON.stringify(t));
  });

  test("swapping two clips across a gap leaves the gap where it was", () => {
    const t = withGap(); // a, gap of 10s, b
    const [a, , b] = t.clips.map((c) => c.id);
    const s = swapClips(t, b, a);
    expect(s.clips.map((c) => (isSlug(c) ? "gap" : c.id))).toEqual([b, "gap", a]);
    expect(gaps(s)).toEqual([10]);
    expect(duration(s)).toBe(duration(t));
  });

  test("gaps that come to meet become one", () => {
    const t = withGap();
    const b = t.clips.at(-1)!.id;
    // Trimming b's head grows the gap before it rather than adding another.
    const t2 = trimClipEdge(t, b, "start", 35);
    expect(gaps(t2)).toEqual([15]);
  });
});

describe("undo removes the version", () => {
  const rig = () => {
    let r = vcs.initRepo(one(), "Import");
    r = vcs.commit(r, rippleDelete(one(), 0, 5), "Cut the head", "you");
    return r;
  };

  test("nothing to undo at the first commit", () => {
    const r = vcs.initRepo(one(), "Import");
    expect(vcs.canUndo(r)).toBe(false);
    expect(vcs.undo(r).undone).toBeNull();
    expect(vcs.log(vcs.undo(r).repo).length).toBe(1);
  });

  test("undo steps back and drops the entry", () => {
    const r = rig();
    expect(vcs.log(r).length).toBe(2);
    const { repo, undone } = vcs.undo(r);
    expect(undone!.message).toBe("Cut the head");
    expect(vcs.log(repo).length).toBe(1);
    expect(vcs.head(repo).message).toBe("Import");
    // Genuinely gone, not merely unreachable.
    expect(repo.commits[undone!.id]).toBeUndefined();
  });

  test("the document returns to its previous state", () => {
    const r = rig();
    expect(duration(vcs.head(r).edl)).toBe(25);
    expect(duration(vcs.head(vcs.undo(r).repo).edl)).toBe(30);
  });

  test("undo does not strand another branch", () => {
    let r = rig();
    r = vcs.branch(r, "variant");        // variant points at the same commit
    r = vcs.switchBranch(r, "main");
    const { repo, undone } = vcs.undo(r);
    // main moved back, but the commit survives because variant still needs it.
    expect(vcs.head(repo).message).toBe("Import");
    expect(repo.commits[undone!.id]).toBeDefined();
    expect(vcs.log(repo, repo.branches.variant).length).toBe(2);
  });

  test("undo does not delete a commit that has a child", () => {
    let r = rig();
    const mid = r.branches[r.current];
    r = vcs.commit(r, one(), "Third", "you");
    const { repo } = vcs.undo(r);
    expect(repo.commits[mid]).toBeDefined();
  });

  test("repeated undo walks back to the import and stops", () => {
    let r = rig();
    r = vcs.commit(r, one(), "Third", "you");
    r = vcs.undo(r).repo;
    r = vcs.undo(r).repo;
    expect(vcs.log(r).length).toBe(1);
    r = vcs.undo(r).repo;
    expect(vcs.log(r).length).toBe(1);
  });

  test("restore still adds an entry — it is not undo", () => {
    const r = rig();
    const first = vcs.log(r).at(-1)!;
    const restored = vcs.restore(r, first.id);
    expect(vcs.log(restored).length).toBe(3);
    expect(vcs.head(restored).message).toContain("Restore");
  });
});
