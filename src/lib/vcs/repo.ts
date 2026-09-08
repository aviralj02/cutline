import { nanoid } from "nanoid";
import type { Edl } from "../edl/types";
import { duration, placed } from "../edl/query";

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

export function deleteBranch(r: Repo, name: string): Repo {
  if (name === r.current || Object.keys(r.branches).length < 2) return r;
  const branches = { ...r.branches };
  delete branches[name];
  return { ...r, branches };
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
  const prevClips = new Set((a?.clips ?? []).map((c) => c.id));
  const nextClips = new Set(b.clips.map((c) => c.id));
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
  clips: edl.clips.length,
  text: edl.text.length,
  duration: duration(edl),
  cuts: Math.max(0, placed(edl).length - 1),
});
