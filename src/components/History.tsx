"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import * as vcs from "@/lib/vcs/repo";
import { fmt } from "@/lib/edl/query";
import { BranchIcon, Button, Chip, PanelHeader, Timecode, UndoIcon } from "@/components/ui";

const ago = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
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
    <div className="flex min-h-0 flex-1 flex-col border-t border-edge">
      <PanelHeader title="Versions">
        <Chip tone="leader">{repo.current}</Chip>
        <Button
          onClick={() => setNaming((v) => !v)}
          icon={<BranchIcon size={13} />}
          title="Fork this version so you can keep two cuts side by side"
        >
          Variant
        </Button>
      </PanelHeader>

      {branches.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-edge px-3 py-2">
          {branches.map((b) => (
            <button
              key={b}
              onClick={() => switchBranch(b)}
              className={`rounded-ctl px-2.5 py-1 text-[12px] transition-[background-color,color,transform] duration-150 active:scale-[.97] ${
                b === repo.current ? "bg-leader text-black" : "text-ink-2 hover:bg-white/[.07] hover:text-ink"
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
          className="border-b border-edge px-3 py-2"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this variant"
            className="w-full rounded-ctl border border-edge bg-raised px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-leader/50"
          />
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {commits.map((c) => {
          const parent = c.parent ? repo.commits[c.parent] : null;
          const d = vcs.diff(parent?.edl ?? null, c.edl);
          const isHead = c.id === headId;
          return (
            <div
              key={c.id}
              className={`group relative flex gap-2.5 px-3 py-2 ${isHead ? "bg-raised/60" : "hover:bg-raised/35"}`}
            >
              {/* A continuous rail, so the list reads as one lineage. */}
              <div className="relative flex w-2 justify-center">
                <span className="absolute inset-y-[-8px] w-px bg-edge" />
                <span
                  className={`relative mt-1.5 h-[7px] w-[7px] rounded-full ring-[3px] ring-panel ${
                    c.author === "agent" ? "bg-leader" : "bg-ink-3"
                  }`}
                />
              </div>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] text-ink">{c.message}</p>
                <p className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-3">
                  <Timecode dim className="!text-[11px]">
                    {fmt(vcs.stats(c.edl).duration)}
                  </Timecode>
                  {parent && d.summary !== "no change" && <span className="text-ink-2">{d.summary}</span>}
                  <span className="ml-auto">{ago(c.at)}</span>
                </p>
              </div>

              {!isHead && (
                <Button
                  onClick={() => restore(c.id)}
                  icon={<UndoIcon size={13} />}
                  className="absolute right-2 top-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                  title="Bring this version back as a new version"
                >
                  Restore
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
