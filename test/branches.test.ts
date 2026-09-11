import { expect, test, describe } from "bun:test";
import { emptyEdl, type Edl } from "../src/lib/edl/types";
import { insertClip, rippleDelete } from "../src/lib/edl/ops";
import * as vcs from "../src/lib/vcs/repo";

const one = (): Edl => insertClip(emptyEdl(30), { src: "m1", in: 10, out: 40 });

/** main: Import → Cut the head. "short" forks there and adds two of its own. */
const rig = () => {
  let r = vcs.initRepo(one(), "Import");
  r = vcs.commit(r, rippleDelete(one(), 0, 5), "Cut the head", "you");
  r = vcs.branch(r, "short");
  r = vcs.commit(r, rippleDelete(one(), 0, 10), "Shorter", "you");
  r = vcs.commit(r, rippleDelete(one(), 0, 15), "Shorter still", "you");
  return vcs.switchBranch(r, "main");
};

describe("deleting a variant", () => {
  test("its name is gone", () => {
    const r = vcs.deleteBranch(rig(), "short");
    expect(Object.keys(r.branches)).toEqual(["main"]);
  });

  test("the versions only it reached are deleted, not stranded", () => {
    const r0 = rig();
    const own = vcs.log(r0, r0.branches.short).slice(0, 2).map((c) => c.id);
    const r = vcs.deleteBranch(r0, "short");
    for (const id of own) expect(r.commits[id]).toBeUndefined();
    expect(Object.keys(r.commits).length).toBe(2);
  });

  test("history it shares with another variant survives", () => {
    const r = vcs.deleteBranch(rig(), "short");
    expect(vcs.log(r).map((c) => c.message)).toEqual(["Cut the head", "Import"]);
  });

  test("deleting the variant you are on moves you to main", () => {
    const r = vcs.deleteBranch(vcs.switchBranch(rig(), "short"), "short");
    expect(r.current).toBe("main");
    expect(vcs.head(r).message).toBe("Cut the head");
  });

  test("main can go too, while another variant remains", () => {
    const r = vcs.deleteBranch(rig(), "main");
    expect(r.current).toBe("short");
    expect(vcs.log(r).length).toBe(4);
  });

  test("the last variant cannot be deleted", () => {
    const r = vcs.initRepo(one(), "Import");
    expect(vcs.deleteBranch(r, "main")).toBe(r);
  });

  test("an unknown name changes nothing", () => {
    const r = rig();
    expect(vcs.deleteBranch(r, "nope")).toBe(r);
  });

  test("it can say beforehand how many versions will go", () => {
    const r = rig();
    expect(vcs.onlyOn(r, "short")).toBe(2);
    // Everything on main is also on short, so deleting main loses nothing.
    expect(vcs.onlyOn(r, "main")).toBe(0);
  });
});
