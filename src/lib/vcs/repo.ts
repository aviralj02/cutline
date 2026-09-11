import { nanoid } from "nanoid";
import type { Edl } from "../edl/types";
import { clipCount, duration, isSlug } from "../edl/query";

export type Author = "you" | "agent";

export interface Commit {
  id: string;
  parent: string | null;
  message: string;
  author: Author;
  at: number;
  /**
   * The full EDL, not a patch. An edit document is a few dozen KB, so
   * snapshots cost nothing and every version is O(1) to restore — no replay,
   * no rebase, no corrupt-history failure mode.
   */
  edl: Edl;
}

export interface Repo {
  commits: Record<string, Commit>;
  /** branch name -> head commit id */
  branches: Record<string, string>;
  current: string;
}

export function initRepo(edl: Edl, message = "Import"): Repo {
  const c: Commit = { id: nanoid(10), parent: null, message, author: "you", at: Date.now(), edl };
  return { commits: { [c.id]: c }, branches: { main: c.id }, current: "main" };
}

export const head = (r: Repo): Commit => r.commits[r.branches[r.current]];

export function commit(r: Repo, edl: Edl, message: string, author: Author): Repo {
  const c: Commit = {
    id: nanoid(10),
    parent: r.branches[r.current] ?? null,
    message,
    author,
    at: Date.now(),
    edl,
  };
  return {
    ...r,
    commits: { ...r.commits, [c.id]: c },
    branches: { ...r.branches, [r.current]: c.id },
  };
}

/** First-parent history for the current branch, newest first. */
export function log(r: Repo, from = r.branches[r.current]): Commit[] {
  const out: Commit[] = [];
  let id: string | null = from ?? null;
  const seen = new Set<string>();
  while (id && r.commits[id] && !seen.has(id)) {
    seen.add(id);
    out.push(r.commits[id]);
    id = r.commits[id].parent;
  }
  return out;
}

export const canUndo = (r: Repo): boolean => !!head(r)?.parent;

/**
 * Step back one version and **drop it from the history**.
 *
 * This is deliberately different from `restore`. Restore is for revisiting a
 * version from a while ago and belongs in the record. Undo is for taking back
 * the thing you just did, where leaving a pair of entries behind — the change
 * and its reversal — turns the history into a log of mistakes instead of a
 * list of states worth returning to.
 *
 * The commit is only deleted when nothing else reaches it, so undoing on one
 * branch can never cut the ground from under another.
 */
export function undo(r: Repo): { repo: Repo; undone: Commit | null } {
  const headId = r.branches[r.current];
  const target = r.commits[headId];
  if (!target?.parent) return { repo: r, undone: null };

  const branches = { ...r.branches, [r.current]: target.parent };
  const stillReachable =
    Object.values(branches).includes(headId) ||
    Object.values(r.commits).some((c) => c.id !== headId && c.parent === headId);

  const commits = { ...r.commits };
  if (!stillReachable) delete commits[headId];
  return { repo: { ...r, commits, branches }, undone: target };
}

/**
 * Restore an old version by committing it forward rather than rewinding the
 * pointer. Undo is itself an edit, so nothing is ever unreachable and the
 * agent can never destroy work it did not understand.
 */
export function restore(r: Repo, commitId: string): Repo {
  const target = r.commits[commitId];
  if (!target) return r;
  return commit(r, target.edl, `Restore "${target.message}"`, "you");
}

/** Fork the current head into a named variant and switch to it. */
export function branch(r: Repo, name: string): Repo {
  if (r.branches[name]) return { ...r, current: name };
  return { ...r, branches: { ...r.branches, [name]: r.branches[r.current] }, current: name };
}

export const switchBranch = (r: Repo, name: string): Repo =>
  r.branches[name] ? { ...r, current: name } : r;

/** Every commit reachable from the given heads, following parents. */
function reachable(r: Repo, heads: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !r.commits[id]) continue;
    seen.add(id);
    const parent = r.commits[id].parent;
    if (parent) stack.push(parent);
  }
  return seen;
}

/** The versions only this variant reaches: exactly what deleting it loses. */
function exclusiveTo(r: Repo, name: string): Set<string> {
  const others = reachable(
    r,
    Object.entries(r.branches).filter(([n]) => n !== name).map(([, id]) => id),
  );
  return new Set([...reachable(r, [r.branches[name]])].filter((id) => !others.has(id)));
}

/** How many versions deleting a variant would take with it. */
export const onlyOn = (r: Repo, name: string): number =>
  r.branches[name] ? exclusiveTo(r, name).size : 0;

/**
 * Delete a variant **and the versions only it reached**. Dropping the name
 * alone would strand them, stored and persisted forever with nothing that can
 * reach them. History shared with another variant stays.
 *
 * Unlike every edit, this is not undoable — it is not a commit, so there is
 * nothing for undo to step back over — which is why the UI confirms it.
 * Deleting the variant you are on moves you to main, or to whatever remains;
 * the last variant cannot go.
 */
export function deleteBranch(r: Repo, name: string): Repo {
  if (!r.branches[name] || Object.keys(r.branches).length < 2) return r;
  const gone = exclusiveTo(r, name);
  const branches = { ...r.branches };
  delete branches[name];
  const commits = { ...r.commits };
  for (const id of gone) delete commits[id];
  const current =
    name !== r.current ? r.current : branches.main ? "main" : Object.keys(branches)[0];
  return { commits, branches, current };
}

export interface Diff {
  clipsAdded: number;
  clipsRemoved: number;
  textAdded: number;
  textRemoved: number;
  deltaSeconds: number;
  /** Human sentence for the history list. */
  summary: string;
}

/** A semantic diff. Nobody wants to read a JSON patch of their edit. */
export function diff(a: Edl | null, b: Edl): Diff {
  // Gaps aren't clips: opening or closing one shows as a change in length, not as a clip.
  const prevClips = new Set((a?.clips ?? []).filter((c) => !isSlug(c)).map((c) => c.id));
  const nextClips = new Set(b.clips.filter((c) => !isSlug(c)).map((c) => c.id));
  const prevText = new Set((a?.text ?? []).map((t) => t.id));
  const nextText = new Set(b.text.map((t) => t.id));

  const d: Diff = {
    clipsAdded: [...nextClips].filter((x) => !prevClips.has(x)).length,
    clipsRemoved: [...prevClips].filter((x) => !nextClips.has(x)).length,
    textAdded: [...nextText].filter((x) => !prevText.has(x)).length,
    textRemoved: [...prevText].filter((x) => !nextText.has(x)).length,
    deltaSeconds: duration(b) - (a ? duration(a) : 0),
    summary: "",
  };

  const bits: string[] = [];
  if (d.clipsRemoved) bits.push(`−${d.clipsRemoved} clip${d.clipsRemoved > 1 ? "s" : ""}`);
  if (d.clipsAdded) bits.push(`+${d.clipsAdded} clip${d.clipsAdded > 1 ? "s" : ""}`);
  if (d.textRemoved) bits.push(`−${d.textRemoved} text`);
  if (d.textAdded) bits.push(`+${d.textAdded} text`);
  if (Math.abs(d.deltaSeconds) >= 0.05) {
    bits.push(`${d.deltaSeconds > 0 ? "+" : "−"}${Math.abs(d.deltaSeconds).toFixed(1)}s`);
  }
  d.summary = bits.length ? bits.join(", ") : "no change";
  return d;
}

export const stats = (edl: Edl) => ({
  clips: clipCount(edl),
  text: edl.text.length,
  duration: duration(edl),
  cuts: Math.max(0, clipCount(edl) - 1),
});
