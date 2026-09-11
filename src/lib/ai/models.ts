import type { ProviderId } from "./providers";

/** A model as far as Cutline needs to know one. */
export interface ModelInfo {
  id: string;
  /** A display name when the provider gives one; otherwise the id. */
  name: string;
  /** Whether it can call tools. Cutline edits only through tools. */
  tools: boolean;
  /** Anthropic reports these per model; a request must not send what the model rejects. */
  thinking: boolean;
  effort: boolean;
  /** Milliseconds since the epoch, where the provider says. */
  created?: number;
}

/** Ids of models that can't drive an edit: embeddings, speech, images, moderation. */
const NOT_CHAT =
  /(embed|tts|whisper|transcribe|audio|realtime|image|dall-e|moderation|rerank|guard|search|computer-use|aqa|imagen|veo|learnlm|live|babbage|davinci|instruct|ocr|sora)/i;

/** The models worth offering: chat models that can call tools. */
export function usable(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.tools && !NOT_CHAT.test(m.id));
}

/** Starting model per provider: first matching pattern, newest match wins. */
const PREFER: Partial<Record<ProviderId, RegExp[]>> = {
  anthropic: [/^claude-opus-5$/, /^claude-opus-/, /^claude-sonnet-/],
  openrouter: [/^anthropic\/claude-opus-5$/, /^anthropic\/claude-opus/, /^openai\/gpt-\d/],
  openai: [/^gpt-\d+(\.\d+)?$/, /^gpt-\d/],
  google: [/^gemini-[\d.]+-pro/, /^gemini-/],
  mistral: [/^mistral-large-latest$/, /^mistral-large/, /^mistral-medium/],
  xai: [/^grok-\d+$/, /^grok-\d/],
  deepseek: [/^deepseek-chat$/],
  groq: [/gpt-oss-120b/, /llama-3\.3-70b/],
};

const unstable = (id: string) => /(preview|exp|beta|alpha)/i.test(id);

/** Newest first: released before preview, then by date, then by version in the id. */
function newest(list: ModelInfo[]): ModelInfo {
  return [...list].sort((a, b) => {
    const u = Number(unstable(a.id)) - Number(unstable(b.id));
    if (u) return u;
    if (a.created && b.created && a.created !== b.created) return b.created - a.created;
    return b.id.localeCompare(a.id, "en", { numeric: true });
  })[0];
}

export function chooseModel(provider: ProviderId, models: ModelInfo[]): string | null {
  const list = usable(models);
  for (const re of PREFER[provider] ?? []) {
    const hits = list.filter((m) => re.test(m.id));
    if (hits.length) return newest(hits).id;
  }
  return list[0]?.id ?? null;
}
