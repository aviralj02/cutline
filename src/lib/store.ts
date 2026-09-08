"use client";

import { create } from "zustand";
import { nanoid } from "nanoid";
import type { Edl } from "./edl/types";
import { duration } from "./edl/query";
import { insertClip } from "./edl/ops";
import { emptyEdl } from "./edl/types";
import * as vcs from "./vcs/repo";
import type { Author, Repo } from "./vcs/repo";
import type { Analysis, MediaInfo } from "./agent/tools";
import { decodeAudio, detectSilences, probeVideo, waveform } from "./media/analyze";
import { putMedia } from "./media/opfs";
import { loadProject, saveProject, clearProject } from "./db";

export interface ChatEntry {
  id: string;
  role: "you" | "agent" | "system";
  text: string;
  /** Tool activity attached to an agent turn. */
  steps?: string[];
  failed?: boolean;
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

  hydrate: () => Promise<void>;
  importFile: (file: File) => Promise<void>;
  apply: (edl: Edl, message: string, author?: Author) => void;
  restore: (commitId: string) => void;
  branch: (name: string) => void;
  switchBranch: (name: string) => void;
  ask: (prompt: string) => Promise<void>;
  setPlayhead: (t: number, fromPlayback?: boolean) => void;
  setPlaying: (p: boolean) => void;
  select: (clipId: string | null) => void;
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

  async importFile(file) {
    set({ status: "Reading file…", busy: true });
    try {
      const id = nanoid(10);
      const meta = await probeVideo(file);
      await putMedia(id, file);

      set({ status: "Analysing audio…" });
      // Decoding the whole audio track is the one slow step on import. It
      // buys the silence map that makes the agent useful, so it happens once
      // here rather than on every request.
      let silences: Array<[number, number]> = [];
      let wave: number[] = [];
      if (meta.hasAudio) {
        try {
          const audio = await decodeAudio(file);
          // Store raw, unpadded detections; padding is a per-request decision.
          silences = detectSilences(audio, { minSilence: 0.2, padding: 0 }).ranges;
          wave = Array.from(waveform(audio, 1600));
        } catch {
          set({ status: "Audio could not be decoded — continuing without silence analysis." });
        }
      }

      const info: MediaInfo = { id, name: file.name, duration: meta.duration };
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
    // A no-op edit must not become a version. Otherwise splitting on a clip
    // boundary, or an agent that decided to change nothing, silently fills
    // the history with entries that restore to the same thing.
    if (JSON.stringify(vcs.head(repo).edl) === JSON.stringify(edl)) return;
    const next = vcs.commit(repo, edl, message, author);
    set({ repo: next, playhead: Math.min(get().playhead, duration(edl)) });
    persist(get());
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

  async ask(prompt) {
    const { repo, media, analysis } = get();
    if (!repo || !prompt.trim()) return;

    const turnId = nanoid(6);
    set((s) => ({
      busy: true,
      playing: false,
      chat: [
        ...s.chat,
        { id: nanoid(6), role: "you", text: prompt },
        { id: turnId, role: "agent", text: "", steps: [] },
      ],
    }));

    const patch = (fn: (e: ChatEntry) => ChatEntry) =>
      set((s) => ({ chat: s.chat.map((e) => (e.id === turnId ? fn(e) : e)) }));

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          edl: edlOf(get().repo),
          context: { media, analysis },
        }),
      });

      if (!res.ok || !res.body) {
        const msg = await res.json().catch(() => ({ error: "Request failed." }));
        patch((e) => ({ ...e, text: msg.error ?? "Request failed.", failed: true }));
        set({ busy: false });
        return;
      }

      // Server-sent events: tool steps arrive as they happen so the user sees
      // the edit being made rather than a spinner.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalEdl: Edl | null = null;
      let said = "";
      const steps: string[] = [];

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === "tool") {
            steps.push(ev.summary);
            patch((e) => ({ ...e, steps: [...steps] }));
          } else if (ev.type === "text") {
            said = said ? `${said}\n${ev.text}` : ev.text;
            patch((e) => ({ ...e, text: said }));
          } else if (ev.type === "done") {
            finalEdl = ev.edl as Edl;
          } else if (ev.type === "error") {
            patch((e) => ({ ...e, text: ev.message, failed: true }));
          }
        }
      }

      // One commit per turn, labelled with what the user actually asked for.
      if (finalEdl && steps.length) get().apply(finalEdl, prompt, "agent");
      if (!said && steps.length) patch((e) => ({ ...e, text: steps.join("; ") }));
    } catch (err) {
      patch((e) => ({
        ...e,
        text: err instanceof Error ? err.message : "Could not reach the agent.",
        failed: true,
      }));
    } finally {
      set({ busy: false });
    }
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
    set({ selectedClip: clipId });
  },

  async reset() {
    await clearProject().catch(() => {});
    set({
      repo: null, media: [], analysis: { silences: {} }, waveforms: {},
      chat: [], playhead: 0, playing: false, selectedClip: null, status: null,
    });
  },
}));
