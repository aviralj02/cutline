"use client";

import { create } from "zustand";
import type { Opener } from "./agent";
import { listAnthropicModels, openAnthropic } from "./anthropic";
import { forgetConnection, loadConnection, saveConnection, type Connection } from "./connection";
import { AiError, explain, type Explained } from "./errors";
import { chooseModel, usable, type ModelInfo } from "./models";
import { listOpenAIModels, openOpenAI } from "./openai";
import { PROVIDERS, type ProviderId } from "./providers";

// The connection as app state, apart from the editor's store: it belongs to the person, not the project.

export interface Draft {
  provider: ProviderId;
  key: string;
  remember: boolean;
}

interface AiState {
  conn: Connection | null;
  /** Usable models for the connected key, fetched when first needed. */
  models: ModelInfo[];
  /** False until storage has been read, which can only happen after mount. */
  hydrated: boolean;
  checking: boolean;
  listing: boolean;
  problem: Explained | null;

  hydrate: () => void;
  connect: (d: Draft) => Promise<boolean>;
  loadModels: () => Promise<void>;
  setModel: (id: string) => void;
  setRemember: (on: boolean) => void;
  forget: () => void;
  clearProblem: () => void;
}

export function listModels(provider: ProviderId, key: string, signal?: AbortSignal) {
  return PROVIDERS[provider].wire === "anthropic"
    ? listAnthropicModels(key, signal)
    : listOpenAIModels(provider, key, signal);
}

export function openerFor(c: Connection): Opener {
  return PROVIDERS[c.provider].wire === "anthropic"
    ? openAnthropic(c.key, c.model)
    : openOpenAI(c.provider, c.key, c.model);
}

export const useAi = create<AiState>((set, get) => ({
  conn: null,
  models: [],
  hydrated: false,
  checking: false,
  listing: false,
  problem: null,

  hydrate() {
    if (get().hydrated) return;
    set({ conn: loadConnection(), hydrated: true });
  },

  async connect(d) {
    set({ checking: true, problem: null });
    const provider = PROVIDERS[d.provider];
    try {
      // Listing models both proves the key and picks the starting model, at no cost.
      const models = await listModels(d.provider, d.key);
      const id = chooseModel(d.provider, models);
      const model = models.find((m) => m.id === id);
      if (!model) throw new AiError("none", "No usable models.");
      const conn: Connection = { provider: d.provider, key: d.key, model, remember: d.remember };
      saveConnection(conn);
      set({ conn, models: usable(models), checking: false });
      return true;
    } catch (err) {
      set({ checking: false, problem: explain(err, provider) });
      return false;
    }
  },

  async loadModels() {
    const { conn, listing, models } = get();
    if (!conn || listing || models.length) return;
    set({ listing: true });
    try {
      set({ models: usable(await listModels(conn.provider, conn.key)), listing: false });
    } catch (err) {
      set({ listing: false, problem: explain(err, PROVIDERS[conn.provider], conn.model.id) });
    }
  },

  setModel(id) {
    const { conn, models } = get();
    const model = models.find((m) => m.id === id);
    if (!conn || !model || conn.model.id === id) return;
    const next = { ...conn, model };
    saveConnection(next);
    set({ conn: next, problem: null });
  },

  setRemember(on) {
    const conn = get().conn;
    if (!conn) return;
    const next = { ...conn, remember: on };
    saveConnection(next);
    set({ conn: next });
  },

  forget() {
    forgetConnection();
    set({ conn: null, models: [], problem: null });
  },

  clearProblem() {
    if (get().problem) set({ problem: null });
  },
}));
