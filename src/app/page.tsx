"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import Preview from "@/components/Preview";
import Timeline from "@/components/Timeline";
import Transport from "@/components/Transport";
import Chat from "@/components/Chat";
import DesktopOnly, {
  MIN_WIDTH,
  useWindowWidth,
} from "@/components/DesktopOnly";
import History from "@/components/History";
import ExportDialog from "@/components/ExportDialog";
import {
  Button,
  ConfirmDialog,
  ExportIcon,
  GithubIcon,
  IconButton,
  Logo,
  NewProjectIcon,
  RedoActionIcon,
  UndoActionIcon,
} from "@/components/ui";

import { SOURCE_URL } from "./site";
import { edlOf } from "@/lib/store";
import { MAX_FILE_BYTES, humanBytes } from "@/lib/media/opfs";
import * as vcs from "@/lib/vcs/repo";

/** A hole plus its gap. Real film has one pitch, and a repeat on it has no seam. */
const PITCH = 21;

/**
 * Sprocket perforations. A hole only reads as a hole if the strip around it
 * is lighter than the hole, so the band is raised and the holes drop to the
 * app background.
 *
 * The strip carries this screen's only motion, and it means what it does on a
 * real gate: still until there is film, advanced by one frame the moment the
 * film is over it, running while it is being read.
 */
function Perforations({ state }: { state: "still" | "threaded" | "running" }) {
  return (
    <div
      className="overflow-hidden bg-[#272727] px-3 py-[5px]"
      aria-hidden="true"
    >
      <div
        style={
          { "--pitch": `${PITCH}px`, gap: PITCH - 13 } as React.CSSProperties
        }
        className={`flex items-center transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)] ${
          state === "running"
            ? "threading"
            : state === "threaded"
              ? "-translate-x-[21px]"
              : ""
        }`}
      >
        {/* Enough to overflow the widest the gate gets, so the strip is cut off
            by the frame rather than ending inside it. */}
        {Array.from({ length: 34 }, (_, i) => (
          <span
            key={i}
            className="h-[9px] w-[13px] shrink-0 rounded-[2px] bg-shell"
          />
        ))}
      </div>
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

  // Still, threaded, running: the gate's three states, and the strip says which.
  const gate = busy ? "running" : over ? "threaded" : "still";

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="w-full max-w-[560px]">
        <div className="settle">
          <h1 className="text-[27px] font-semibold leading-[1.15] tracking-[-.025em] text-balance text-ink">
            Every edit is a version
            <br />
            you can go back to.
          </h1>
          <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-ink-2">
            Drop in a video and start cutting. Cutline reads the audio as it
            imports, so the dead air is already found - trim it yourself, or
            ask.
          </p>
        </div>

        {/* The gate. Sprocket edges and its own corner, unlike every control
            around it — this is where the film goes. The file input is
            invisible, so the focus ring has to be drawn by the gate itself or
            a keyboard lands on nothing. */}
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
          style={{ animationDelay: "90ms" }}
          className={`settle mt-7 block cursor-pointer overflow-hidden rounded-panel border transition-colors duration-200
                      focus-within:border-leader focus-within:ring-2 focus-within:ring-leader ${
                        over
                          ? "border-leader bg-leader/[.07]"
                          : "border-edge bg-panel hover:border-ink-3 hover:bg-raised/40"
                      }`}
        >
          <input
            type="file"
            accept="video/*"
            className="sr-only"
            onChange={(e) => take(e.target.files)}
            disabled={busy}
          />
          <Perforations state={gate} />
          <div className="px-6 py-8 text-center">
            <p className="text-[14px] font-medium text-ink">
              {busy
                ? (status ?? "Working")
                : over
                  ? "Release to load it"
                  : "Drop a video, or click to choose"}
            </p>
            <p className="mt-1.5 text-[12.5px] text-ink-3">
              {busy
                ? "Reading it on your machine."
                : over
                  ? "It never leaves this machine."
                  : `MP4 or WebM, up to ${humanBytes(MAX_FILE_BYTES)}.`}
            </p>
          </div>
          <Perforations state={gate} />
        </label>

        {/* An import that fails leaves `busy` false, so the reason has to live
            outside the panel that only speaks while work is happening. */}
        {!busy && status && (
          <p
            role="alert"
            className="rise-in mt-3 text-[12.5px] leading-relaxed text-grease"
          >
            {status}
          </p>
        )}

        <div className="settle" style={{ animationDelay: "170ms" }}>
          <dl className="mt-7 grid grid-cols-3 gap-5 border-t border-edge pt-5">
            {[
              // The claims in the order the product makes them: it works by
              // hand, it never loses a cut, and asking is an option on top.
              ["No sign-up", "No account, and nothing uploads."],
              ["Never lose a cut", "Restore any earlier version."],
              ["AI if you want it", "Bring your own key."],
            ].map(([term, detail]) => (
              <div key={term}>
                <dt className="text-[12.5px] font-medium text-ink">{term}</dt>
                <dd className="mt-1 text-[12px] leading-relaxed text-ink-3">
                  {detail}
                </dd>
              </div>
            ))}
          </dl>

          {/* An editor that claims your footage never leaves the machine should
              let you go and check.

              It carries Button's mechanics — 32px tall, `rounded-ctl`, the
              same press — without being one: this navigates, and a button that
              navigates is the wrong element. One hover signal, not two: the
              surface and border answer the pointer, so an underline on top
              would be the same message said twice. Keyboard focus gets exactly
              what hover gets. */}
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Cutline on GitHub. Free and open source."
            className="mt-5 inline-flex h-8 items-center gap-2 rounded-ctl border border-edge bg-panel px-3 text-[12.5px] text-ink-3
                       transition-[background-color,border-color,color,transform] duration-150
                       hover:border-ink-3 hover:bg-raised hover:text-ink
                       focus-visible:border-ink-3 focus-visible:bg-raised focus-visible:text-ink
                       active:scale-[.97]"
          >
            <GithubIcon size={14} className="shrink-0" />
            Free and open source
          </a>
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  const hydrate = useStore((s) => s.hydrate);
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
  const [exporting, setExporting] = useState(false);

  // Which rail panels are open: a per-viewer convenience, remembered in this browser.
  const [rail, setRail] = useState({ ask: true, versions: true });
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("cutline.rail") ?? "null",
      ) as Record<string, unknown> | null;
      if (saved)
        setRail({
          ask: saved.ask !== false,
          versions: saved.versions !== false,
        });
    } catch {
      /* storage blocked; both stay open */
    }
  }, []);
  const fold = (panel: "ask" | "versions") =>
    setRail((r) => {
      const next = { ...r, [panel]: !r[panel] };
      try {
        localStorage.setItem("cutline.rail", JSON.stringify(next));
      } catch {
        /* not remembered, still folds */
      }
      return next;
    });
  const windowWidth = useWindowWidth();

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

  // Before anything mounts, so no work is done for a screen that cannot use it.
  if (windowWidth > 0 && windowWidth < MIN_WIDTH)
    return <DesktopOnly width={windowWidth} />;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-shell">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel px-3">
        <Logo />
        {repo && media[0] && (
          <>
            <span className="h-3.5 w-px bg-edge" />
            <span className="truncate text-[12.5px] text-ink-2">
              {media[0].name}
            </span>
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
            <Button
              onClick={() => setConfirmingReset(true)}
              icon={<NewProjectIcon />}
            >
              New project
            </Button>
            {/* The one action that turns the edit into a file, so it takes the primary treatment. */}
            <Button
              variant="primary"
              onClick={() => setExporting(true)}
              icon={<ExportIcon size={13} />}
            >
              Export
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
                {atStake?.versions ?? 0} version
                {atStake?.versions === 1 ? "" : "s"}
              </strong>
              {atStake && atStake.branches > 1
                ? ` across ${atStake.branches} variants`
                : ""}{" "}
              and{" "}
              <strong className="font-medium text-ink">
                {atStake?.files ?? 0} imported file
                {atStake?.files === 1 ? "" : "s"}
              </strong>
              .
            </p>
            <p className="mt-2">Undo cannot bring it back.</p>
          </>
        }
      />

      {/* Mounted only while open: a closed dialog's text still answers text
          queries, and its length row shadowed the timeline's own timecode. */}
      {exporting && <ExportDialog open onClose={() => setExporting(false)} />}

      {/* The landing is what the server sends. A "Loading" shell was all a
          crawler ever saw — most do not run JS — so the page had no indexable
          content at all. A saved project takes its place a moment later, once
          IndexedDB answers, which is also the only honest first render: until
          it does, nobody knows whether there is a project. */}
      {!repo ? (
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
            <Chat open={rail.ask} onToggle={() => fold("ask")} />
            <History open={rail.versions} onToggle={() => fold("versions")} />
          </aside>
        </main>
      )}
    </div>
  );
}
