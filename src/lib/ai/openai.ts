import { TOOLS } from "../agent/tools";
import type { Opener, Seed, ToolCall, ToolReply, Turn } from "./agent";
import { AiError, classify } from "./errors";
import type { ModelInfo } from "./models";
import { PROVIDERS, type ProviderId } from "./providers";

// The OpenAI chat-completions wire every provider but Anthropic speaks, over plain fetch.

type Json = Record<string, unknown>;

/** Gemini's schema subset lacks additionalProperties; applyTool ignores unknown keys anyway. */
function withoutClosedObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutClosedObjects);
  if (!schema || typeof schema !== "object") return schema;
  const out: Json = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") continue;
    out[k] = withoutClosedObjects(v);
  }
  return out;
}

export function openaiTools(provider: ProviderId) {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: provider === "google" ? withoutClosedObjects(t.input_schema) : t.input_schema,
    },
  }));
}

function headers(provider: ProviderId, key: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  // OpenRouter attributes traffic by this header; it names the app, never the user.
  if (provider === "openrouter") h["X-Title"] = "Cutline";
  return h;
}

async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new AiError("aborted", "Stopped.");
    }
    throw new AiError("network", err instanceof Error ? err.message : "Network error.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as unknown;
    // Gemini sometimes wraps OpenAI's error object in an array.
    const e = ((Array.isArray(body) ? body[0] : body) as Json | null)?.error as Json | string | undefined;
    const message = typeof e === "string" ? e : String(e?.message ?? res.statusText ?? "");
    const code = typeof e === "object" && e ? String(e.code ?? e.type ?? e.status ?? "") : "";
    throw classify(res.status, message, code);
  }
  return (await res.json()) as Json;
}

export async function listOpenAIModels(
  provider: ProviderId,
  key: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const json = await request(`${PROVIDERS[provider].baseUrl}/models`, { headers: headers(provider, key) }, signal);
  const data = (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []) as Json[];
  return data
    .map((m): ModelInfo => {
      const id = String(m.id ?? m.name ?? "").replace(/^models\//, "");
      const params = m.supported_parameters as string[] | undefined;
      return {
        id,
        name: provider === "openrouter" && typeof m.name === "string" ? m.name : id,
        // Only OpenRouter reports tool support; elsewhere the first request tells.
        tools: Array.isArray(params) ? params.includes("tools") : true,
        thinking: false,
        effort: false,
        created: typeof m.created === "number" ? m.created * 1000 : undefined,
      };
    })
    .filter((m) => m.id);
}

/** Read one completion into a turn, and the assistant message to keep. Pure. */
export function readChoice(json: Json): { turn: Turn; message: Json } {
  const choice = (json.choices as Json[] | undefined)?.[0];
  if (!choice) throw new AiError("other", "The response held no answer.");
  const msg = (choice.message ?? {}) as Json;
  const raw = (msg.tool_calls ?? []) as Json[];

  const calls = raw.map((c, i): ToolCall => {
    const fn = (c.function ?? {}) as Json;
    const call: ToolCall = { id: String(c.id || `call_${i}`), name: String(fn.name ?? ""), input: null };
    try {
      const v = JSON.parse(String(fn.arguments || "{}"));
      if (v && typeof v === "object" && !Array.isArray(v)) call.input = v as Record<string, unknown>;
      else call.bad = "Arguments were not a JSON object.";
    } catch {
      call.bad = "Arguments were not valid JSON.";
    }
    return call;
  });

  const content = msg.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => String((p as Json).text ?? "")).join("")
        : "";

  const finish = String(choice.finish_reason ?? "");
  const stop: Turn["stop"] = calls.length
    ? "tools"
    : finish === "length"
      ? "length"
      : finish === "content_filter"
        ? "refused"
        : "done";

  // Rebuilt, not echoed: some providers reject their own reasoning fields sent back.
  const message: Json = {
    role: "assistant",
    content: typeof content === "string" ? content : text || null,
    ...(calls.length && {
      tool_calls: calls.map((c, i) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: String(((raw[i].function ?? {}) as Json).arguments || "{}") },
      })),
    }),
  };
  return { turn: { text, calls, stop }, message };
}

export function openOpenAI(provider: ProviderId, key: string, model: ModelInfo): Opener {
  const url = `${PROVIDERS[provider].baseUrl}/chat/completions`;
  const tools = openaiTools(provider);
  return (seed: Seed) => {
    const messages: Json[] = [
      { role: "system", content: seed.system },
      ...seed.history.map((m) => ({ role: m.role, content: m.text })),
    ];
    return {
      async turn(signal) {
        const json = await request(
          url,
          {
            method: "POST",
            headers: headers(provider, key),
            body: JSON.stringify({ model: model.id, messages, tools, tool_choice: "auto" }),
          },
          signal,
        );
        const { turn, message } = readChoice(json);
        messages.push(message);
        return turn;
      },
      reply(results: ToolReply[]) {
        for (const r of results) {
          messages.push({ role: "tool", tool_call_id: r.call.id, content: r.content });
        }
      },
    };
  };
}
