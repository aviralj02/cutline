import { expect, test, describe } from "bun:test";
import { emptyEdl, type Edl } from "../src/lib/edl/types";
import { duration, placed, resolve } from "../src/lib/edl/query";
import { insertClip, trimClipEdge, rippleDelete } from "../src/lib/edl/ops";
import * as vcs from "../src/lib/vcs/repo";

const one = (): Edl => insertClip(emptyEdl(30), { src: "m1", in: 10, out: 40 });
const two = (): Edl => insertClip(one(), { src: "m1", in: 50, out: 60 });

describe("trimming a clip by its edges", () => {
  test("dragging the head in shortens it and pulls the rest earlier", () => {
    const e = two(); // 0-30 then 30-40
    const id = e.clips[0].id;
    const t = trimClipEdge(e, id, "start", 5);
    expect(t.clips[0].in).toBe(15); // 10 + 5s of source
    expect(duration(t)).toBe(35);
    expect(placed(t)[1].start).toBe(25); // the next clip moved earlier
  });

  test("dragging the tail in shortens only that clip", () => {
    const e = two();
    const id = e.clips[0].id;
    const t = trimClipEdge(e, id, "end", 20);
    expect(t.clips[0].out).toBe(30);
    expect(duration(t)).toBe(30);
    expect(t.clips[1].in).toBe(50); // untouched
  });

  test("the head cannot pass the tail", () => {
    const e = one();
    const t = trimClipEdge(e, e.clips[0].id, "start", 999);
    expect(t.clips[0].in).toBeLessThan(t.clips[0].out);
    expect(duration(t)).toBeGreaterThan(0);
  });

  test("the tail cannot pass the head", () => {
    const e = one();
    const t = trimClipEdge(e, e.clips[0].id, "end", -50);
    expect(t.clips[0].out).toBeGreaterThan(t.clips[0].in);
  });

  test("a clip cannot be extended past the start of its own footage", () => {
    const e = one(); // source in = 10
    const t = trimClipEdge(e, e.clips[0].id, "start", -60);
    expect(t.clips[0].in).toBe(0);
  });

  test("a clip cannot be extended past the end of its own footage", () => {
    const e = one(); // source out = 40, file is 45s long
    const t = trimClipEdge(e, e.clips[0].id, "end", 999, 45);
    expect(t.clips[0].out).toBe(45);
  });

  test("extending the head reveals earlier footage", () => {
    const e = one();
    const t = trimClipEdge(e, e.clips[0].id, "start", -5);
    expect(t.clips[0].in).toBe(5);
    expect(resolve(t, 0)!.sourceTime).toBe(5);
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
