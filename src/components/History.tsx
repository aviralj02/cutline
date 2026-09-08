"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import * as vcs from "@/lib/vcs/repo";
import { fmt } from "@/lib/edl/query";

const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function History() {
  const repo = useStore((s) => s.repo);
  const restore = useStore((s) => s.restore);
  const branch = useStore((s) => s.branch);
  const switchBranch = useStore((s) => s.switchBranch);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const commits = useMemo(() => (repo ? vcs.log(repo) : []), [repo]);
  if (!repo) return null;

  const headId = repo.branches[repo.current];
  const branches = Object.keys(repo.branches);

  return (
    <div className="flex min-h-0 flex-col border-t border-white/8">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-[11px] font-medium tracking-wide text-white/50">VERSIONS</span>
        <span className="rounded bg-white/8 px-1.5 py-0.5 font-mono text-[10px] text-[#f5b544]">
          {repo.current}
        </span>
        <button
          onClick={() => setNaming((v) => !v)}
          className="ml-auto text-[11px] text-white/40 transition hover:text-white"
          title="Fork this version into a named variant"
        >
          + variant
        </button>
      </div>

      {branches.length > 1 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {branches.map((b) => (
            <button
              key={b}
              onClick={() => switchBranch(b)}
              className={`rounded-full px-2 py-0.5 text-[11px] transition ${
                b === repo.current
                  ? "bg-[#f5b544] text-black"
                  : "border border-white/10 text-white/50 hover:text-white"
              }`}
            >
              {b}
            </button>
          ))}
        </div>
      )}

      {naming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (n) branch(n);
            setName("");
            setNaming(false);
          }}
          className="px-4 pb-2"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="tiktok-cut"
            className="w-full rounded bg-white/5 px-2 py-1 text-xs text-white outline-none ring-1 ring-white/10 focus:ring-[#f5b544]/50"
          />
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {commits.map((c) => {
          const parent = c.parent ? repo.commits[c.parent] : null;
          const d = vcs.diff(parent?.edl ?? null, c.edl);
          const isHead = c.id === headId;
          return (
            <div
              key={c.id}
              className={`group relative rounded-md px-2.5 py-2 transition ${
                isHead ? "bg-white/[.06]" : "hover:bg-white/[.03]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    c.author === "agent" ? "bg-[#f5b544]" : "bg-white/40"
                  }`}
                />
                <span className="truncate text-xs text-white/80">{c.message}</span>
                {isHead && (
                  <span className="ml-auto shrink-0 text-[10px] font-medium text-[#f5b544]">now</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px] text-white/30">
                <span>{ago(c.at)}</span>
                <span>·</span>
                <span className="font-mono">{fmt(vcs.stats(c.edl).duration)}</span>
                {parent && d.summary !== "no change" && (
                  <>
                    <span>·</span>
                    <span className="text-white/45">{d.summary}</span>
                  </>
                )}
                {!isHead && (
                  <button
                    onClick={() => restore(c.id)}
                    className="ml-auto opacity-0 transition group-hover:opacity-100 hover:text-[#f5b544]"
                  >
                    restore
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
