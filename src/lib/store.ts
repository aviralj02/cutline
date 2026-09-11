"use client";

import { create } from "zustand";
import { nanoid } from "nanoid";
import type { Edl } from "./edl/types";
import { duration } from "./edl/query";
import { insertClip } from "./edl/ops";
import { emptyEdl } from "./edl/types";
import * as vcs from "./vcs/repo";
import type { Author, Commit, Repo } from "./vcs/repo";
import type { Analysis, MediaInfo } from "./agent/tools";
import {
  decodeAudio, detectSilences, probeVideo, silencesFromLoudness, summariseAudio, waveform,
  type Probe,
} from "./media/analyze";
import { checkRoom, clearMedia, keepStorage, putMedia } from "./media/opfs";
import { loadProject, saveProject, clearProject } from "./db";
import { runAgent, type Exchange } from "./ai/agent";
import { AiError, explain, type Failure } from "./ai/errors";
import { PROVIDERS } from "./ai/providers";
import { openerFor, useAi } from "./ai/session";

export interface ChatEntry {
  id: string;
  role: "you" | "agent" | "system";
  text: string;
  /** Tool activity attached to an agent turn. */
  steps?: string[];
  failed?: boolean;
  /** How to fix a failure, beneath what went wrong. */
  fix?: string;
  kind?: Failure;
  /** Stopped by the user: the steps were shown but never applied. */
  stopped?: boolean;
  /** Which model answered, since the model can change between turns. */
  model?: string;
}

/** Earlier requests and replies for follow-ups; failed and stopped turns are left out. */
function exchanges(chat: ChatEntry[]): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < chat.length - 1; i++) {
    const [a, b] = [chat[i], chat[i + 1]];
    if (a.role === "you" && b.role === "agent" && !b.failed && !b.stopped) {
      out.push({ prompt: a.text, reply: b.text || (b.steps ?? []).join("; ") });
    }
  }
  return out;
}

interface State {
  ready: boolean;
  status: string | null;
  repo: Repo | null;
  media: MediaInfo[];
  analysis: Analysis;
  waveforms: Record<string, number[]>;
  chat: ChatEntry[];
  busy: boolean;
  playhead: number;
  playing: boolean;
  selectedClip: string | null;
  /** The effect under the inspector. Selection is view state, not document state. */
  selectedEffect: string | null;
  /** Crop-handle mode. A view state, never part of the edit. */
  cropping: boolean;
  /**
   * An uncommitted edit shown everywhere the document is, so a drag previews
   * live. Committing it writes exactly one version for the whole gesture.
   */
  draft: Edl | null;
  /**
   * Undone versions, held in memory only. Undo removes an entry from the
   * history, so redo has nowhere else to find it — and any new edit discards
   * the stack, the way every editor behaves.
   */
  redoStack: Commit[];

  hydrate: () => Promise<void>;
  /** Shared by the first import and by adding a file to an open project. */
  analyzeFile: (file: File) => Promise<{
    id: string;
    meta: Probe;
    info: MediaInfo;
    silences: Array<[number, number]>;
    wave: number[];
    /** It has audio, but the audio could not be analysed. */
    unheard: boolean;
  }>;
  importFile: (file: File) => Promise<void>;
  apply: (edl: Edl, message: string, author?: Author) => void;
  restore: (commitId: string) => void;
  branch: (name: string) => void;
  switchBranch: (name: string) => void;
  /** Not undoable — the one caller confirms first. */
  deleteBranch: (name: string) => void;
  ask: (prompt: string) => Promise<void>;
  /** Abandon the running request. Nothing it did is applied. */
  stop: () => void;
  controller: AbortController | null;
  setPlayhead: (t: number, fromPlayback?: boolean) => void;
  setPlaying: (p: boolean) => void;
  select: (clipId: string | null) => void;
  selectEffect: (effectId: string | null) => void;
  setCropping: (on: boolean) => void;
  setDraft: (edl: Edl | null) => void;
  commitDraft: (message: string) => void;
  undo: () => void;
  redo: () => void;
  addMedia: (file: File) => Promise<void>;
  reset: () => Promise<void>;
}

const persist = (s: State) => {
  if (!s.repo) return;
  void saveProject({
    media: s.media,
    analysis: s.analysis,
    waveforms: s.waveforms,
    repo: s.repo,
    savedAt: Date.now(),
  }).catch(() => {
    /* storage full or blocked; the session still works in memory */
  });
};

export const edlOf = (repo: Repo | null): Edl => (repo ? vcs.head(repo).edl : emptyEdl());

/**
 * The document as it should currently be seen: the uncommitted draft while a
 * gesture is in flight, otherwise the head of the branch.
 */
export const useEdl = (): Edl => {
  const repo = useStore((s) => s.repo);
  const draft = useStore((s) => s.draft);
  return draft ?? edlOf(repo);
};

export const useStore = create<State>((set, get) => ({
  ready: false,
  status: null,
  repo: null,
  media: [],
  analysis: { silences: {} },
  waveforms: {},
  chat: [],
  busy: false,
  playhead: 0,
  playing: false,
  selectedClip: null,
  selectedEffect: null,
  cropping: false,
  draft: null,
  redoStack: [],
  controller: null,

  async hydrate() {
    try {
      const p = await loadProject();
      if (p?.repo) {
        set({
          repo: p.repo,
          media: p.media,
          analysis: p.analysis,
          waveforms: p.waveforms,
          ready: true,
        });
        return;
      }
    } catch {
      /* first run, or storage unavailable */
    }
    set({ ready: true });
  },

  async analyzeFile(file) {
    // Ask about room before doing any work. A file that cannot be stored
    // should say so in a second, not after a minute of analysis.
    const problem = await checkRoom(file);
    if (problem) throw new Error(problem);

    const id = nanoid(10);
    const meta = await probeVideo(file);
    set({ status: `Storing ${file.name}…` });
    await putMedia(id, file);
    // Asked once there is something worth keeping. Some browsers put this to
    // the user, and a permission prompt makes more sense over footage that is
    // already stored than over one that may yet be refused.
    void keepStorage();

    let silences: Array<[number, number]> = [];
    let wave: number[] = [];
    let unheard = false;
    if (meta.hasAudio) {
      const pct = (f: number) => set({ status: `Analysing audio… ${Math.round(f * 100)}%` });
      try {
        // The streaming path holds one chunk at a time, so the length of the
        // file stops being the thing that decides whether an import survives.
        const sum = await summariseAudio(file, { buckets: 1600, onProgress: pct });
        if (sum) {
          // Store raw, unpadded detections; padding is a per-request decision.
          silences = silencesFromLoudness(sum.db, sum.hopSec, { minSilence: 0.2, padding: 0 }, sum.startSec).ranges;
          wave = Array.from(sum.wave);
        }
      } catch {
        // Codecs WebCodecs won't decode go through Web Audio, which holds the whole file, so it's capped.
        try {
          set({ status: "Analysing audio…" });
          const audio = await decodeAudio(file);
          silences = detectSilences(audio, { minSilence: 0.2, padding: 0 }).ranges;
          wave = Array.from(waveform(audio, 1600));
        } catch {
          unheard = true;
          set({ status: "Audio could not be read — continuing without silence analysis." });
        }
      }
    }
    const info: MediaInfo = { id, name: file.name, duration: meta.duration };
    return { id, meta, info, silences, wave, unheard };
  },

  async importFile(file) {
    set({ status: "Reading file…", busy: true });
    try {
      // Reading the audio is the one slow step on import. It buys the silence
      // map that makes the agent useful, so it happens once here rather than
      // on every request, and reports progress because a long file otherwise
      // looks like a hung tab.
      const { id, meta, info, silences, wave, unheard } = await get().analyzeFile(file);

      const edl = insertClip(
        emptyEdl(meta.fps, meta.width || 1920, meta.height || 1080),
        { src: id, in: 0, out: meta.duration },
      );

      const repo = vcs.initRepo(edl, `Import ${file.name}`);
      const removable = silences.reduce((a, [x, y]) => a + (y - x), 0);
      set((s) => ({
        repo,
        media: [...s.media, info],
        analysis: { silences: { ...s.analysis.silences, [id]: silences } },
        waveforms: { ...s.waveforms, [id]: wave },
        playhead: 0,
        busy: false,
        status: null,
        chat: [
          {
            id: nanoid(6),
            role: "system",
            text: silences.length
              ? `Imported ${file.name}. Found ${silences.length} pauses totalling ${removable.toFixed(1)}s that could be cut.`
              : unheard
                ? `Imported ${file.name}. Its audio couldn't be analysed here, so there are no pauses to cut.`
                : `Imported ${file.name}.`,
          },
        ],
      }));
      persist(get());
    } catch (err) {
      set({
        busy: false,
        status: err instanceof Error ? err.message : "Import failed.",
      });
    }
  },

  apply(edl, message, author = "you") {
    const repo = get().repo;
    if (!repo) return;
    // Any new edit invalidates the redo stack.
    if (get().redoStack.length) set({ redoStack: [] });
    // A no-op edit must not become a version. Otherwise splitting on a clip
    // boundary, or an agent that decided to change nothing, silently fills
    // the history with entries that restore to the same thing.
    if (JSON.stringify(vcs.head(repo).edl) === JSON.stringify(edl)) return;
    const next = vcs.commit(repo, edl, message, author);
    set({ repo: next, draft: null, playhead: Math.min(get().playhead, duration(edl)) });
    persist(get());
  },

  undo() {
    const repo = get().repo;
    if (!repo) return;
    const { repo: next, undone } = vcs.undo(repo);
    if (!undone) return;
    set({
      repo: next,
      draft: null,
      playing: false,
      redoStack: [...get().redoStack, undone],
      playhead: Math.min(get().playhead, duration(vcs.head(next).edl)),
    });
    persist(get());
  },

  redo() {
    const repo = get().repo;
    const stack = get().redoStack;
    const entry = stack.at(-1);
    if (!repo || !entry) return;
    // Re-commit the undone document; `apply` would clear the stack, so the
    // commit is made directly and the entry popped.
    set({
      repo: vcs.commit(repo, entry.edl, entry.message, entry.author),
      draft: null,
      redoStack: stack.slice(0, -1),
    });
    persist(get());
  },

  async addMedia(file) {
    const repo = get().repo;
    if (!repo) return;
    set({ status: `Adding ${file.name}…`, busy: true });
    try {
      const { id, meta, info, silences, wave, unheard } = await get().analyzeFile(file);
      // Append to the primary track. The composition frame stays as the first
      // file set it, so a differently shaped clip letterboxes rather than
      // resizing the whole project underneath the edit.
      const next = insertClip(edlOf(repo), { src: id, in: 0, out: meta.duration });
      set((s) => ({
        media: [...s.media, info],
        analysis: { silences: { ...s.analysis.silences, [id]: silences } },
        waveforms: { ...s.waveforms, [id]: wave },
        busy: false,
        status: null,
        chat: [
          ...s.chat,
          {
            id: nanoid(6),
            role: "system",
            text: silences.length
              ? `Added ${file.name}. Found ${silences.length} more pauses that could be cut.`
              : unheard
                ? `Added ${file.name}. Its audio couldn't be analysed here, so it has no pauses to cut.`
                : `Added ${file.name}.`,
          },
        ],
      }));
      get().apply(next, `Add ${file.name}`);
    } catch (err) {
      // `status` is only read by the import screen, and this runs inside the
      // editor — so the reason goes where the other facts about the footage
      // are, or a refused file fails in silence.
      const text = err instanceof Error ? err.message : "Could not add that file.";
      set((s) => ({
        busy: false,
        status: text,
        chat: [...s.chat, { id: nanoid(6), role: "system", text, failed: true }],
      }));
    }
  },

  restore(commitId) {
    const repo = get().repo;
    if (!repo) return;
    set({ repo: vcs.restore(repo, commitId), playing: false });
    persist(get());
  },

  branch(name) {
    const repo = get().repo;
    if (!repo) return;
    set({ repo: vcs.branch(repo, name) });
    persist(get());
  },

  switchBranch(name) {
    const repo = get().repo;
    if (!repo) return;
    set({ repo: vcs.switchBranch(repo, name), playing: false, playhead: 0 });
    persist(get());
  },

  deleteBranch(name) {
    const repo = get().repo;
    if (!repo) return;
    const next = vcs.deleteBranch(repo, name);
    if (next === repo) return;
    // Deleting the variant you are on lands you on another. The redo stack,
    // the draft and the selection all belonged to the one that is gone.
    const moved = next.current !== repo.current;
    set({
      repo: next,
      ...(moved && {
        playing: false, playhead: 0, draft: null, redoStack: [],
        selectedClip: null, selectedEffect: null,
      }),
    });
    persist(get());
  },

  async ask(prompt) {
    const { repo, media, analysis, chat, busy } = get();
    const conn = useAi.getState().conn;
    // The composer only exists once a model is connected.
    if (!repo || !conn || busy || !prompt.trim()) return;

    const turnId = nanoid(6);
    const controller = new AbortController();
    set((s) => ({
      busy: true,
      playing: false,
      controller,
      chat: [
        ...s.chat,
        { id: nanoid(6), role: "you", text: prompt },
        { id: turnId, role: "agent", text: "", steps: [], model: conn.model.id },
      ],
    }));

    const patch = (fn: (e: ChatEntry) => ChatEntry) =>
      set((s) => ({ chat: s.chat.map((e) => (e.id === turnId ? fn(e) : e)) }));
    const provider = PROVIDERS[conn.provider];

    try {
      // Runs in the browser, so the key goes only to the provider; steps show as they happen.
      const run = await runAgent({
        edl: edlOf(repo),
        ctx: { media, analysis },
        prompt,
        prior: exchanges(chat),
        open: openerFor(conn),
        signal: controller.signal,
        onStep: (summary) => patch((e) => ({ ...e, steps: [...(e.steps ?? []), summary] })),
        onText: (text) => patch((e) => ({ ...e, text })),
      });

      if (run.stop === "refused") {
        const x = explain(new AiError("refused", run.text), provider, conn.model.id);
        patch((e) => ({ ...e, text: x.title, fix: x.fix, failed: true, kind: x.kind }));
        return;
      }
      // One version per request, labelled with what was actually asked for.
      if (run.steps.length) get().apply(run.edl, prompt, "agent");
      const note =
        run.stop === "cap"
          ? "It stopped after twelve rounds without finishing. What it did so far is saved."
          : run.stop === "length"
            ? "Its reply ran past the length limit and was cut short."
            : "";
      const said = run.text || (run.steps.length ? "" : "Nothing needed changing.");
      patch((e) => ({ ...e, text: [said, note].filter(Boolean).join("\n") }));
    } catch (err) {
      const x = explain(err, provider, conn.model.id);
      patch((e) =>
        x.kind === "aborted"
          ? { ...e, text: "Stopped. Nothing was changed.", stopped: true }
          : { ...e, text: x.title, fix: x.fix, failed: true, kind: x.kind },
      );
    } finally {
      set({ busy: false, controller: null });
    }
  },

  stop() {
    get().controller?.abort();
  },

  setPlayhead(t, fromPlayback = false) {
    const d = duration(edlOf(get().repo));
    const clamped = Math.max(0, Math.min(d, t));
    set({ playhead: clamped, ...(fromPlayback ? {} : { playing: false }) });
    if (fromPlayback && clamped >= d) set({ playing: false });
  },

  setPlaying(p) {
    const d = duration(edlOf(get().repo));
    if (p && get().playhead >= d - 0.01) set({ playhead: 0 });
    set({ playing: p });
  },

  select(clipId) {
    // The two selections are exclusive: one inspector, one subject.
    set({ selectedClip: clipId, selectedEffect: null });
  },

  selectEffect(effectId) {
    set({ selectedEffect: effectId, selectedClip: null });
  },

  setCropping(on) {
    set({ cropping: on, playing: false });
  },

  setDraft(edl) {
    set({ draft: edl });
  },

  commitDraft(message) {
    const { draft } = get();
    set({ draft: null });
    if (draft) get().apply(draft, message);
  },

  async reset() {
    // Otherwise a running request would land its edit on a deleted project.
    get().controller?.abort();
    // The preview stays mounted, reading the files, until the state below
    // clears — so playback stops before they go.
    set({ playing: false });
    // The record and the footage live in two stores. Clearing only the
    // record left every imported file in OPFS, eating the quota a little
    // more with each new project.
    await Promise.all([clearProject().catch(() => {}), clearMedia()]);
    set({
      repo: null, media: [], analysis: { silences: {} }, waveforms: {},
      chat: [], playhead: 0, playing: false, selectedClip: null, selectedEffect: null,
      cropping: false, draft: null, redoStack: [], status: null,
    });
  },
}));
