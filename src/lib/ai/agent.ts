import type { Edl } from "../edl/types";
import { applyTool, describeState, SYSTEM_PROMPT, type AgentContext } from "../agent/tools";
import { AiError } from "./errors";

// The agent loop, in the browser; each wire implements Conversation, so the loop never knows the provider.

export interface ToolCall {
  id: string;
  name: string;
  /** Null when the model sent arguments that could not be read. */
  input: Record<string, unknown> | null;
  /** Why `input` is null. */
  bad?: string;
}

export interface ToolReply {
  call: ToolCall;
  content: string;
  error: boolean;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
  /** tools: run them and continue; again: continue as is; the rest end the run. */
  stop: "tools" | "again" | "done" | "refused" | "length";
}

export interface Seed {
  system: string;
  /** Earlier exchanges, then the request itself, last. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface Conversation {
  turn(signal: AbortSignal): Promise<Turn>;
  /** All of a turn's results in one message, or models stop calling tools in parallel. */
  reply(results: ToolReply[]): void;
}

export type Opener = (seed: Seed) => Conversation;

/** An earlier request and what came of it, so "a bit more" means something. */
export interface Exchange {
  prompt: string;
  reply: string;
}

export interface RunResult {
  edl: Edl;
  /** One line per tool call that ran. */
  steps: string[];
  text: string;
  stop: "done" | "refused" | "length" | "cap";
}

/** A confused model cannot spend forever. */
const MAX_TURNS = 12;
/** Enough context for a follow-up, not a transcript's worth of tokens. */
const MAX_PRIOR = 6;

export function seedFor(edl: Edl, ctx: AgentContext, prompt: string, prior: Exchange[] = []): Seed {
  const history: Seed["history"] = [];
  for (const x of prior.slice(-MAX_PRIOR)) {
    // Only the current state is described; earlier ones are stale.
    if (!x.prompt.trim() || !x.reply.trim()) continue;
    history.push({ role: "user", text: x.prompt }, { role: "assistant", text: x.reply });
  }
  history.push({
    role: "user",
    text: `Current edit:\n\n${describeState(edl, ctx)}\n\n---\n\nRequest: ${prompt}`,
  });
  return { system: SYSTEM_PROMPT, history };
}

export async function runAgent(o: {
  edl: Edl;
  ctx: AgentContext;
  prompt: string;
  prior?: Exchange[];
  open: Opener;
  signal: AbortSignal;
  onStep?: (summary: string, edl: Edl) => void;
  onText?: (text: string) => void;
  maxTurns?: number;
}): Promise<RunResult> {
  let edl = o.edl;
  const steps: string[] = [];
  const said: string[] = [];
  const convo = o.open(seedFor(o.edl, o.ctx, o.prompt, o.prior));
  const stopped = () => new AiError("aborted", "Stopped.");

  for (let n = 0; n < (o.maxTurns ?? MAX_TURNS); n++) {
    if (o.signal.aborted) throw stopped();
    const turn = await convo.turn(o.signal);
    if (turn.text.trim()) {
      said.push(turn.text.trim());
      o.onText?.(said.join("\n"));
    }
    if (turn.stop === "again") continue;
    if (turn.stop !== "tools" || !turn.calls.length) {
      return { edl, steps, text: said.join("\n"), stop: turn.stop === "tools" ? "done" : turn.stop };
    }

    const results = turn.calls.map((call): ToolReply => {
      if (!call.input) {
        return { call, content: `Error: ${call.bad ?? "Unreadable arguments."} Call ${call.name} again with valid JSON arguments.`, error: true };
      }
      try {
        const out = applyTool(edl, o.ctx, call.name, call.input);
        edl = out.edl;
        steps.push(out.summary);
        o.onStep?.(out.summary, edl);
        return { call, content: out.result, error: out.result.startsWith("Error") };
      } catch (err) {
        return { call, content: `Error: ${err instanceof Error ? err.message : "Tool failed."}`, error: true };
      }
    });
    // A stop during tool calls still discards the run: no half-made edits.
    if (o.signal.aborted) throw stopped();
    convo.reply(results);
  }
  return { edl, steps, text: said.join("\n"), stop: "cap" };
}
