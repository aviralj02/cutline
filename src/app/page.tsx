"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import Preview from "@/components/Preview";
import Timeline from "@/components/Timeline";
import Transport from "@/components/Transport";
import Chat from "@/components/Chat";
import History from "@/components/History";
import { Button, ConfirmDialog, IconButton, Logo, NewProjectIcon, RedoActionIcon, UndoActionIcon } from "@/components/ui";
import { edlOf } from "@/lib/store";
import * as vcs from "@/lib/vcs/repo";

/**
 * Sprocket perforations. A hole only reads as a hole if the strip around it
 * is lighter than the hole, so the band is raised and the holes drop to the
 * app background.
 */
function Perforations({ count = 20 }: { count?: number }) {
  return (
    <div className="flex items-center justify-between bg-[#272727] px-3 py-[5px]" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="h-[9px] w-[13px] rounded-[2px] bg-shell" />
      ))}
    </div>
  );
}

function Start() {
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
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-[560px]">
        <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-.025em] text-ink">
          Every edit is a version
          <br />
          you can go back to.
        </h1>
        <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-ink-2">
          Drop in a video. Cutline reads the audio as it imports, so it already knows
          where the dead air is when you ask it to cut.
        </p>

        {/* The gate. Sharp corners and sprocket edges, unlike every control
            around it — this is where the film goes. */}
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
          className={`mt-7 block cursor-pointer overflow-hidden rounded-panel border transition-colors duration-150 ${
            over ? "border-leader bg-leader/[.07]" : "border-edge bg-panel hover:border-ink-3"
          }`}
        >
          <input
            type="file"
            accept="video/*"
            className="sr-only"
            onChange={(e) => take(e.target.files)}
            disabled={busy}
          />
          <Perforations />
          <div className="px-6 py-8 text-center">
            <p className="text-[14px] font-medium text-ink">
              {busy ? status ?? "Working" : "Drop a video, or click to choose"}
            </p>
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              {busy ? "Running on your machine." : "MP4 or WebM."}
            </p>
          </div>
          <Perforations />
        </label>

        <dl className="mt-7 grid grid-cols-3 gap-5 border-t border-edge pt-5">
          {[
            ["Nothing uploads", "Footage stays on your machine."],
            ["Ask for the edit", "Say what you want changed."],
            ["Never lose a cut", "Restore any earlier version."],
          ].map(([term, detail]) => (
            <div key={term}>
              <dt className="text-[12.5px] font-medium text-ink">{term}</dt>
              <dd className="mt-1 text-[12px] leading-relaxed text-ink-3">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>
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
  const media = useStore((s) => s.media);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const redoStack = useStore((s) => s.redoStack);
  const edl = edlOf(repo);
  const canUndo = !!repo && vcs.canUndo(repo);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // Name what is actually at stake, rather than asking "are you sure?".
  const atStake = useMemo(() => {
    if (!repo) return null;
    const versions = vcs.log(repo).length;
    const branches = Object.keys(repo.branches).length;
    return { versions, branches, files: media.length };
  }, [repo, media.length]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "TEXTAREA"].includes(el.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!playing);
      }
      // The shortcut everyone reaches for without thinking.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, setPlaying, undo, redo]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-shell">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel px-3">
        <Logo />
        {repo && media[0] && (
          <>
            <span className="h-3.5 w-px bg-edge" />
            <span className="truncate text-[12.5px] text-ink-2">{media[0].name}</span>
            <span className="tnum shrink-0 font-mono text-[11px] text-ink-3">
              {edl.width}×{edl.height} at {edl.fps} fps
            </span>
          </>
        )}
        {repo && (
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              label="Undo"
              title="Undo the last change (⌘Z). It leaves no trace in the version history."
              icon={<UndoActionIcon />}
              disabled={!canUndo}
              onClick={undo}
            />
            <IconButton
              label="Redo"
              title="Redo the change you just undid (⇧⌘Z)"
              icon={<RedoActionIcon />}
              disabled={!redoStack.length}
              onClick={redo}
            />
            <span className="mx-1 h-4 w-px bg-edge" />
            <Button onClick={() => setConfirmingReset(true)} icon={<NewProjectIcon />}>
              New project
            </Button>
          </div>
        )}
      </header>

      {/* Everything else in the app is undoable. This is not: it clears the
          stored project and the imported media outright. */}
      <ConfirmDialog
        open={confirmingReset}
        title="Start a new project?"
        confirmLabel="Delete and start over"
        cancelLabel="Keep editing"
        onCancel={() => setConfirmingReset(false)}
        onConfirm={() => {
          setConfirmingReset(false);
          void reset();
        }}
        body={
          <>
            <p>
              This permanently deletes the current project from this browser —{" "}
              <strong className="font-medium text-ink">
                {atStake?.versions ?? 0} version{atStake?.versions === 1 ? "" : "s"}
              </strong>
              {atStake && atStake.branches > 1 ? ` across ${atStake.branches} variants` : ""} and{" "}
              <strong className="font-medium text-ink">
                {atStake?.files ?? 0} imported file{atStake?.files === 1 ? "" : "s"}
              </strong>
              .
            </p>
            <p className="mt-2">Undo cannot bring it back.</p>
          </>
        }
      />

      {!ready ? (
        <div className="grid flex-1 place-items-center text-[12px] text-ink-3">Loading</div>
      ) : !repo ? (
        <Start />
      ) : (
        <main className="gate-in flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            <Preview />
            {/* Breathing room, so the timeline reads as its own instrument
                rather than as the bottom edge of the viewer. */}
            <div className="shrink-0 bg-shell px-3 pb-3 pt-2 xl:pt-7">
              <div className="relative">
                <div className="mb-2 flex justify-center xl:absolute xl:-top-4 xl:left-2/5 xl:z-20 xl:mb-0 xl:block xl:-translate-x-1/2">
                  <Transport />
                </div>
                
                <Timeline />
              </div>
            </div>
          </section>
          <aside className="flex w-[290px] shrink-0 flex-col border-l border-edge bg-panel xl:w-[340px]">
            <Chat />
            <History />
          </aside>
        </main>
      )}
    </div>
  );
}
