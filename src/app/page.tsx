"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import Preview from "@/components/Preview";
import Timeline from "@/components/Timeline";
import Chat from "@/components/Chat";
import History from "@/components/History";

function Dropzone() {
  const importFile = useStore((s) => s.importFile);
  const busy = useStore((s) => s.busy);
  const status = useStore((s) => s.status);
  const [over, setOver] = useState(false);

  const take = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (f) void importFile(f);
    },
    [importFile],
  );

  return (
    <div className="grid flex-1 place-items-center p-8">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
        className={`flex w-full max-w-lg cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed px-8 py-16 text-center transition ${
          over ? "border-[#f5b544] bg-[#f5b544]/5" : "border-white/15 hover:border-white/30"
        }`}
      >
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => take(e.target.files)}
          disabled={busy}
        />
        <div className="grid h-11 w-11 place-items-center rounded-full bg-white/5 text-[#f5b544]">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M10 14V4m0 0L6 8m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <p className="text-sm text-white/85">{busy ? status ?? "Working…" : "Drop a video, or click to choose"}</p>
          <p className="mt-1 text-xs text-white/35">
            {busy ? "This runs entirely on your machine." : "MP4 or WebM. Nothing is uploaded."}
          </p>
        </div>
      </label>
    </div>
  );
}

export default function Page() {
  const hydrate = useStore((s) => s.hydrate);
  const ready = useStore((s) => s.ready);
  const repo = useStore((s) => s.repo);
  const reset = useStore((s) => s.reset);
  const setPlaying = useStore((s) => s.setPlaying);
  const playing = useStore((s) => s.playing);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Space toggles playback, the way every editor works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!playing);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, setPlaying]);

  return (
    <div className="flex h-dvh flex-col bg-[#0b0b0d] text-white antialiased">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/8 px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight">
          cut<span className="text-[#f5b544]">line</span>
        </span>
        <span className="text-[11px] text-white/30">agentic editing, versioned</span>
        {repo && (
          <button
            onClick={() => void reset()}
            className="ml-auto text-[11px] text-white/35 transition hover:text-white"
          >
            New project
          </button>
        )}
      </header>

      {!ready ? (
        <div className="grid flex-1 place-items-center text-xs text-white/30">Loading…</div>
      ) : !repo ? (
        <Dropzone />
      ) : (
        <main className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <Preview />
            <Timeline />
          </section>
          <aside className="flex w-[340px] shrink-0 flex-col border-l border-white/8 bg-[#0e0e11]">
            <Chat />
            <div className="h-[38%] min-h-0">
              <History />
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}
