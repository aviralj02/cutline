import { describe, expect, test } from "bun:test";
import { emptyEdl } from "../src/lib/edl/types";
import { insertClip } from "../src/lib/edl/ops";
import { duration } from "../src/lib/edl/query";
import type { AgentContext } from "../src/lib/agent/tools";
import { cleanKey, detect, maskKey, PROVIDERS } from "../src/lib/ai/providers";
import { chooseModel, usable, type ModelInfo } from "../src/lib/ai/models";
import { AiError, classify, explain } from "../src/lib/ai/errors";
import { openaiTools, readChoice } from "../src/lib/ai/openai";
import { anthropicParams, readAnthropic } from "../src/lib/ai/anthropic";
import { runAgent, seedFor, type Conversation, type Seed, type ToolReply, type Turn } from "../src/lib/ai/agent";

const ctx: AgentContext = {
  media: [{ id: "m1", name: "interview.mp4", duration: 60 }],
  analysis: { silences: { m1: [[10, 13]] } },
};
const base = () => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 60 });
const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id, name: id, tools: true, thinking: false, effort: false, ...extra,
});

describe("recognising a key", () => {
  test("a distinctive prefix names one provider, with certainty", () => {
    expect(detect("sk-ant-api03-abcdefghijklmnop")).toEqual({ candidates: ["anthropic"], sure: true });
    expect(detect("sk-or-v1-0123456789abcdef").candidates).toEqual(["openrouter"]);
    expect(detect("AIzaSyA1234567890abcdefghijklmnopqrstuv").candidates).toEqual(["google"]);
    expect(detect("gsk_0123456789abcdef").candidates).toEqual(["groq"]);
    expect(detect("xai-0123456789abcdef").candidates).toEqual(["xai"]);
    expect(detect("sk-proj-0123456789abcdef").candidates).toEqual(["openai"]);
  });

  test("a bare sk- key is a choice, not a guess", () => {
    const hex = detect("sk-" + "0123456789abcdef0123456789abcdef");
    expect(hex.sure).toBe(false);
    expect(hex.candidates).toEqual(["deepseek", "openai"]);
    const mixed = detect("sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4");
    expect(mixed.candidates).toEqual(["openai", "deepseek"]);
  });

  test("an unrecognisable key names nobody", () => {
    expect(detect("hello there")).toEqual({ candidates: [], sure: false });
  });

  test("pasted wrapping is cleaned off", () => {
    expect(cleanKey('  "Bearer sk-ant-abc123"\n')).toBe("sk-ant-abc123");
    expect(detect("  sk-ant-abc123 ").sure).toBe(true);
  });

  test("a masked key keeps its prefix and tail, and nothing between", () => {
    const k = "sk-ant-api03-SECRETSECRETSECRET-wxyz";
    const m = maskKey(k);
    expect(m.endsWith("wxyz")).toBe(true);
    expect(m.startsWith("sk-ant-")).toBe(true);
    expect(m).not.toContain("SECRET");
  });
});

describe("choosing a model", () => {
  test("Anthropic starts on Opus 5", () => {
    const list = [model("claude-haiku-4-5"), model("claude-opus-5"), model("claude-sonnet-5")];
    expect(chooseModel("anthropic", list)).toBe("claude-opus-5");
  });

  test("the newest match wins, so a new release needs no code change", () => {
    const list = [model("claude-opus-4-7", { created: 1 }), model("claude-opus-4-8", { created: 2 })];
    expect(chooseModel("anthropic", list)).toBe("claude-opus-4-8");
    const openai = [model("gpt-4o"), model("gpt-5"), model("gpt-5.1"), model("gpt-5-mini")];
    expect(chooseModel("openai", openai)).toBe("gpt-5.1");
  });

  test("a released model is preferred over a preview", () => {
    const list = [model("gemini-2.5-flash"), model("gemini-2.5-pro"), model("gemini-3-pro-preview")];
    expect(chooseModel("google", list)).toBe("gemini-2.5-pro");
  });

  test("models that cannot edit are never offered", () => {
    const list = [
      model("text-embedding-3-large"), model("whisper-1"), model("gpt-image-1"),
      model("gpt-4o-realtime-preview"), model("gpt-5"), model("x/no-tools", { tools: false }),
    ];
    expect(usable(list).map((m) => m.id)).toEqual(["gpt-5"]);
  });

  test("OpenRouter defaults to Opus 5 when it lists it", () => {
    const list = [model("openai/gpt-5"), model("anthropic/claude-opus-5")];
    expect(chooseModel("openrouter", list)).toBe("anthropic/claude-opus-5");
  });

  test("with no preference, the first usable model; with none usable, nothing", () => {
    expect(chooseModel("groq", [model("qwen-3-32b")])).toBe("qwen-3-32b");
    expect(chooseModel("openai", [model("whisper-1")])).toBeNull();
  });
});

describe("failures say what to do", () => {
  test("status and message together decide the kind", () => {
    expect(classify(401).kind).toBe("key");
    // Google answers a bad key with a 400.
    expect(classify(400, "API key not valid. Please pass a valid API key.").kind).toBe("key");
    // OpenAI answers an empty account with a 429 that is not a rate limit.
    expect(classify(429, "You exceeded your current quota", "insufficient_quota").kind).toBe("credit");
    expect(classify(400, "Your credit balance is too low").kind).toBe("credit");
    expect(classify(429, "Rate limit reached").kind).toBe("rate");
    expect(classify(403).kind).toBe("access");
    expect(classify(404).kind).toBe("model");
    expect(classify(529).kind).toBe("busy");
    expect(classify(400, "This model does not support tools").kind).toBe("tools");
    expect(classify(400, "messages: field required").kind).toBe("other");
  });

  test("the words name the provider and give a fix", () => {
    const x = explain(classify(401), PROVIDERS.openai);
    expect(x.title).toContain("OpenAI");
    expect(x.fix.length).toBeGreaterThan(10);
    expect(explain(new AiError("aborted", "Stopped."), PROVIDERS.anthropic).fix).toBe("Nothing was changed.");
  });

  test("an unreachable provider is named, with what to check", () => {
    const x = explain(new AiError("network", "Failed to fetch"), PROVIDERS.groq);
    expect(x.title).toBe("Couldn't reach Groq.");
    expect(x.fix).toContain("connection");
  });
});

describe("the OpenAI-compatible wire", () => {
  test("tool calls are parsed and their ids echoed back", () => {
    const { turn, message } = readChoice({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          reasoning_content: "should not be echoed",
          tool_calls: [{ id: "c1", type: "function", function: { name: "ripple_delete", arguments: '{"start":0,"end":5}' } }],
        },
      }],
    });
    expect(turn.stop).toBe("tools");
    expect(turn.calls[0]).toMatchObject({ id: "c1", name: "ripple_delete", input: { start: 0, end: 5 } });
    expect((message.tool_calls as Array<{ id: string }>)[0].id).toBe("c1");
    // Rebuilt, not echoed: some providers refuse their own reasoning back.
    expect(message).not.toHaveProperty("reasoning_content");
  });

  test("unreadable arguments become an error for the model, not a crash", () => {
    const { turn } = readChoice({
      choices: [{ message: { tool_calls: [{ function: { name: "split", arguments: "{at: 3" } }] } }],
    });
    expect(turn.calls[0].input).toBeNull();
    expect(turn.calls[0].bad).toContain("JSON");
    expect(turn.calls[0].id).toBe("call_0");
  });

  test("finish reasons map onto how the turn ended", () => {
    const end = (finish_reason: string) =>
      readChoice({ choices: [{ finish_reason, message: { content: "ok" } }] }).turn.stop;
    expect(end("stop")).toBe("done");
    expect(end("length")).toBe("length");
    expect(end("content_filter")).toBe("refused");
  });

  test("an empty response is an error", () => {
    expect(() => readChoice({ choices: [] })).toThrow(AiError);
  });

  test("Gemini gets schemas without closed objects; everyone else keeps them", () => {
    const g = JSON.stringify(openaiTools("google"));
    expect(g).not.toContain("additionalProperties");
    expect(JSON.stringify(openaiTools("openai"))).toContain("additionalProperties");
    expect(openaiTools("groq").length).toBeGreaterThan(5);
  });
});

describe("the Anthropic wire", () => {
  test("Opus 5 thinks adaptively, at high effort, with refusal fallbacks", () => {
    const p = anthropicParams(model("claude-opus-5", { thinking: true, effort: true }), "sys", []);
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  test("a model that reports no thinking or effort is not sent either", () => {
    const p = anthropicParams(model("claude-haiku-4-5"), "sys", []);
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("output_config");
    expect(p).not.toHaveProperty("fallbacks");
    expect(p).not.toHaveProperty("betas");
  });

  test("thinking travels back verbatim when nothing fell back", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "tool_use", id: "t1", name: "split", input: { at: 3 } },
    ] as never;
    const { echo, calls } = readAnthropic(content);
    expect(echo.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(calls.map((c) => c.id)).toEqual(["t1"]);
  });

  test("after a fallback, the declining model's internals and calls are dropped", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Looking" },
      { type: "tool_use", id: "early", name: "split", input: { at: 1 } },
      { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
      { type: "text", text: "Done" },
      { type: "tool_use", id: "late", name: "split", input: { at: 2 } },
    ] as never;
    const { echo, calls, text } = readAnthropic(content);
    expect(echo.map((b) => b.type)).toEqual(["text", "text", "tool_use"]);
    expect(calls.map((c) => c.id)).toEqual(["late"]);
    expect(text).toBe("Looking\nDone");
  });
});

/** A model that follows a script, recording what it was told. */
function scripted(turns: Turn[]) {
  const replies: ToolReply[][] = [];
  let seen: Seed | null = null;
  let i = 0;
  const open = (seed: Seed): Conversation => {
    seen = seed;
    return {
      turn: async () => turns[i++] ?? { text: "", calls: [], stop: "done" },
      reply: (r) => replies.push(r),
    };
  };
  return { open, replies, seed: () => seen };
}

const call = (id: string, name: string, input: Record<string, unknown> | null) => ({ id, name, input });

describe("the agent loop", () => {
  test("runs every call in a turn, replies once with all results, and stops when told", async () => {
    const m = scripted([
      { text: "", stop: "tools", calls: [call("a", "ripple_delete", { start: 0, end: 10 }), call("b", "split", { at: 5 })] },
      { text: "Cut the first ten seconds.", stop: "done", calls: [] },
    ]);
    const run = await runAgent({ edl: base(), ctx, prompt: "cut", open: m.open, signal: new AbortController().signal });
    expect(duration(run.edl)).toBe(50);
    expect(run.edl.clips.length).toBe(2);
    expect(run.steps.length).toBe(2);
    expect(m.replies.length).toBe(1);
    expect(m.replies[0].map((r) => r.call.id)).toEqual(["a", "b"]);
    expect(run.text).toBe("Cut the first ten seconds.");
    expect(run.stop).toBe("done");
  });

  test("a bad call is answered with an error and changes nothing", async () => {
    const m = scripted([
      { text: "", stop: "tools", calls: [{ ...call("a", "split", null), bad: "Arguments were not valid JSON." }, call("b", "explode", {})] },
    ]);
    const run = await runAgent({ edl: base(), ctx, prompt: "x", open: m.open, signal: new AbortController().signal });
    expect(duration(run.edl)).toBe(60);
    expect(m.replies[0].every((r) => r.error)).toBe(true);
    expect(m.replies[0][0].content).toContain("valid JSON");
  });

  test("a model that never stops is capped", async () => {
    const forever: Turn = { text: "", stop: "tools", calls: [call("a", "split", { at: 1 })] };
    const m = scripted(Array(20).fill(forever));
    const run = await runAgent({ edl: base(), ctx, prompt: "x", open: m.open, signal: new AbortController().signal, maxTurns: 3 });
    expect(run.stop).toBe("cap");
    expect(m.replies.length).toBe(3);
  });

  test("stopping throws, so a half-made edit is never applied", async () => {
    const ctl = new AbortController();
    const open = (): Conversation => ({
      turn: async () => {
        ctl.abort();
        return { text: "", stop: "tools", calls: [call("a", "ripple_delete", { start: 0, end: 10 })] };
      },
      reply: () => {},
    });
    const err = await runAgent({ edl: base(), ctx, prompt: "x", open, signal: ctl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("aborted");
  });

  test("a paused turn continues without a reply", async () => {
    const m = scripted([
      { text: "", stop: "again", calls: [] },
      { text: "Done.", stop: "done", calls: [] },
    ]);
    const run = await runAgent({ edl: base(), ctx, prompt: "x", open: m.open, signal: new AbortController().signal });
    expect(run.text).toBe("Done.");
    expect(m.replies.length).toBe(0);
  });

  test("a follow-up carries earlier exchanges, then the request with the current state", () => {
    const seed = seedFor(base(), ctx, "a bit more", [
      { prompt: "cut the silences", reply: "Removed 1 stretch" },
      { prompt: "failed one", reply: "" },
    ]);
    expect(seed.history.map((h) => h.role)).toEqual(["user", "assistant", "user"]);
    expect(seed.history[0].text).toBe("cut the silences");
    expect(seed.history.at(-1)!.text).toContain("Current edit:");
    expect(seed.history.at(-1)!.text).toContain("Request: a bit more");
  });

  test("only the most recent exchanges are kept", () => {
    const prior = Array.from({ length: 10 }, (_, i) => ({ prompt: `p${i}`, reply: `r${i}` }));
    const seed = seedFor(base(), ctx, "x", prior);
    expect(seed.history.length).toBe(6 * 2 + 1);
    expect(seed.history[0].text).toBe("p4");
  });
});
