import Anthropic from "@anthropic-ai/sdk";
import { TOOLS } from "../agent/tools";
import type { Opener, Seed, ToolCall, ToolReply, Turn } from "./agent";
import { AiError, classify } from "./errors";
import type { ModelInfo } from "./models";

// Anthropic via the official SDK in the browser; the key is the user's own, the case dangerouslyAllowBrowser permits.

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Block = Anthropic.Beta.Messages.BetaContentBlock;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** Anthropic's guidance: its top models get server-side refusal fallbacks. */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

export const anthropicClient = (key: string) =>
  new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

export function fromAnthropic(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === "AbortError")) {
    return new AiError("aborted", "Stopped.");
  }
  if (err instanceof Anthropic.APIConnectionError) return new AiError("network", err.message);
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { type?: string; message?: string } } | undefined;
    return classify(err.status ?? 0, body?.error?.message ?? err.message, body?.error?.type ?? "");
  }
  return new AiError("other", err instanceof Error ? err.message : String(err));
}

export async function listAnthropicModels(key: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  try {
    const out: ModelInfo[] = [];
    for await (const m of anthropicClient(key).models.list({ limit: 100 }, { signal })) {
      out.push({
        id: m.id,
        name: m.display_name,
        tools: true,
        // From the model, not assumed: unsupported thinking or effort is a 400.
        thinking: m.capabilities?.thinking?.types?.adaptive?.supported ?? false,
        effort: m.capabilities?.effort?.supported ?? false,
        created: Date.parse(m.created_at) || undefined,
      });
    }
    return out;
  } catch (err) {
    throw fromAnthropic(err);
  }
}

/** One turn's request, shaped by what the model reports it supports. Pure. */
export function anthropicParams(model: ModelInfo, system: string, messages: MessageParam[]): Params {
  return {
    model: model.id,
    max_tokens: 16000,
    system,
    tools: TOOLS as unknown as Params["tools"],
    messages,
    ...(model.thinking && { thinking: { type: "adaptive" as const } }),
    ...(model.effort && { output_config: { effort: "high" as const } }),
    ...(FALLBACK_MODELS.has(model.id) && {
      fallbacks: "default" as const,
      betas: ["server-side-fallback-2026-07-01"],
    }),
  };
}

/** What to echo and run: everything, except the declining model's internals and calls before a fallback. */
export function readAnthropic(content: Block[]): { echo: Block[]; calls: ToolCall[]; text: string } {
  const kinds = content.map((b) => b.type as string);
  const boundary = kinds.lastIndexOf("fallback");
  const echo = content.filter((b, i) => {
    const kind = b.type as string;
    if (kind === "fallback") return false;
    return i > boundary || kind === "text";
  });
  const calls: ToolCall[] = [];
  const texts: string[] = [];
  for (const b of echo) {
    if (b.type === "text") texts.push(b.text);
    if (b.type === "tool_use") {
      const ok = !!b.input && typeof b.input === "object" && !Array.isArray(b.input);
      calls.push({
        id: b.id,
        name: b.name,
        input: ok ? (b.input as Record<string, unknown>) : null,
        ...(!ok && { bad: "Arguments were not a JSON object." }),
      });
    }
  }
  return { echo, calls, text: texts.join("\n") };
}

export function openAnthropic(key: string, model: ModelInfo): Opener {
  const client = anthropicClient(key);
  return (seed: Seed) => {
    const messages: MessageParam[] = seed.history.map((m) => ({ role: m.role, content: m.text }));
    return {
      async turn(signal): Promise<Turn> {
        let res: Anthropic.Beta.Messages.BetaMessage;
        try {
          res = await client.beta.messages.create(anthropicParams(model, seed.system, messages), { signal });
        } catch (err) {
          throw fromAnthropic(err);
        }
        // Checked before content: a declined turn's content is not an answer.
        if (res.stop_reason === "refusal") {
          return { text: res.stop_details?.explanation ?? "", calls: [], stop: "refused" };
        }
        const { echo, calls, text } = readAnthropic(res.content);
        if (echo.length) {
          messages.push({ role: "assistant", content: echo as Anthropic.Beta.Messages.BetaContentBlockParam[] });
        }
        const stop: Turn["stop"] =
          res.stop_reason === "tool_use" && calls.length
            ? "tools"
            : res.stop_reason === "pause_turn"
              ? "again"
              : res.stop_reason === "max_tokens"
                ? "length"
                : "done";
        return { text, calls, stop };
      },
      reply(results: ToolReply[]) {
        messages.push({
          role: "user",
          content: results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.call.id,
            content: r.content,
            ...(r.error && { is_error: true }),
          })),
        });
      },
    };
  };
}

