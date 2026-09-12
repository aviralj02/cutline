"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, useEdl } from "@/lib/store";
import { duration, fmt, outputSize } from "@/lib/edl/query";
import { wantsAudio } from "@/lib/export/plan";
import { ExportCancelled, exportSupport, exportVideo, type ExportProgress } from "@/lib/export/render";
import { humanBytes } from "@/lib/media/opfs";
import { Button, Dialog, ExportIcon, SaveIcon } from "@/components/ui";

/** The one place an edit becomes a file. Everything runs here; nothing uploads. */
export default function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const edl = useEdl();
  const media = useStore((s) => s.media);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [done, setDone] = useState<{ url: string; name: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  const size = outputSize(edl);
  const total = duration(edl);
  const working = !!progress && !done && !error;

  // The container depends on what this browser can encode, so it is named up front, not guessed.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const sounds = new Set(media.filter((m) => m.kind === "sound").map((m) => m.id));
    void exportSupport(edl, wantsAudio(edl, (id) => !sounds.has(id))).then((choice) => {
      if (!live) return;
      setFormat(
        choice
          ? `${choice.container.toUpperCase()}, ${choice.video === "avc" ? "H.264" : choice.video.toUpperCase()}${
              choice.audio ? "" : ", no sound — this browser cannot encode audio"
            }`
          : "This browser cannot encode video",
      );
    });
    return () => {
      live = false;
    };
  }, [open, edl, media]);

  const release = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  const close = () => {
    abort.current?.abort();
    abort.current = null;
    release();
    setProgress(null);
    setDone(null);
    setError(null);
    onClose();
  };

  const run = async () => {
    release();
    setDone(null);
    setError(null);
    setProgress({ phase: "picture", done: 0, total: frameHint(edl.fps, total) });
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await exportVideo({
        edl,
        media,
        signal: controller.signal,
        onProgress: setProgress,
      });
      const url = URL.createObjectURL(result.blob);
      urlRef.current = url;
      setDone({ url, name: result.name, size: result.blob.size });
    } catch (err) {
      if (err instanceof ExportCancelled) setProgress(null);
      else setError(err instanceof Error ? err.message : "The export did not finish.");
    } finally {
      abort.current = null;
    }
  };

  const save = () => {
    if (!done) return;
    const a = document.createElement("a");
    a.href = done.url;
    a.download = done.name;
    a.click();
  };

  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  // No corner close: every state ends in one dismissal button, and two controls named Close is one too many.
  return (
    <Dialog open={open} onClose={close} title="Export video" className="w-[440px] max-w-[92vw]">
      <div className="px-4 pb-4 pt-3">
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          Renders on this machine, frame by frame, and never uploads your footage.
        </p>

        <dl className="mt-3 space-y-1.5 rounded-ctl bg-white/[.03] px-3 py-2.5 text-[12px]">
          <Row term="Picture" detail={`${size.width} × ${size.height} at ${edl.fps} fps`} />
          <Row term="Length" detail={fmt(total)} />
          <Row term="File" detail={format ?? "Checking what this browser can write"} />
        </dl>

        {working && (
          <div className="mt-3.5">
            <div className="flex items-baseline justify-between text-[12px]">
              <span className="text-ink-2">
                {progress?.phase === "picture"
                  ? "Rendering the picture"
                  : progress?.phase === "sound"
                    ? "Mixing the sound"
                    : "Writing the file"}
              </span>
              <span className="tnum font-mono text-[11px] text-ink-3">{pct}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[.08]">
              <div
                className="h-full rounded-full bg-leader transition-[width] duration-200"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          </div>
        )}

        {done && (
          <p className="mt-3.5 text-[12.5px] text-ink-2">
            <span className="text-ink">{done.name}</span> is ready, {humanBytes(done.size)}.
          </p>
        )}

        {error && (
          <p role="alert" className="mt-3.5 text-[12.5px] leading-relaxed text-grease">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          {working ? (
            <Button onClick={close}>Stop</Button>
          ) : done ? (
            <>
              <Button onClick={close}>Close</Button>
              <Button variant="primary" size="md" icon={<SaveIcon size={14} />} onClick={save}>
                Save video
              </Button>
            </>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" size="md" icon={<ExportIcon size={14} />} onClick={run} disabled={total <= 0}>
                Export video
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function Row({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-ink-3">{term}</dt>
      <dd className="truncate text-right text-ink-2">{detail}</dd>
    </div>
  );
}

/** A first total so the bar starts somewhere sensible before the first frame lands. */
const frameHint = (fps: number, total: number) => Math.max(1, Math.round(total * fps));
