// Providers a key can come from; each answers a browser CORS preflight, so requests need no server.

/** Keys only: no custom endpoint, since an arbitrary URL's browser access can't be checked. */
export type ProviderId =
  | "anthropic" | "openai" | "google" | "openrouter" | "groq" | "mistral" | "xai" | "deepseek";

export type Wire = "anthropic" | "openai";

export interface Provider {
  id: ProviderId;
  name: string;
  wire: Wire;
  /** OpenAI-compatible base URL, no trailing slash. Unused on the Anthropic wire. */
  baseUrl: string;
  /** Where to make a key. */
  keyUrl: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: {
    id: "anthropic", name: "Anthropic", wire: "anthropic",
    baseUrl: "https://api.anthropic.com", keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    id: "openai", name: "OpenAI", wire: "openai",
    baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    id: "google", name: "Google Gemini", wire: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    id: "openrouter", name: "OpenRouter", wire: "openai",
    baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys",
  },
  groq: {
    id: "groq", name: "Groq", wire: "openai",
    baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys",
  },
  mistral: {
    id: "mistral", name: "Mistral", wire: "openai",
    baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys",
  },
  xai: {
    id: "xai", name: "xAI", wire: "openai",
    baseUrl: "https://api.x.ai/v1", keyUrl: "https://console.x.ai",
  },
  deepseek: {
    id: "deepseek", name: "DeepSeek", wire: "openai",
    baseUrl: "https://api.deepseek.com", keyUrl: "https://platform.deepseek.com/api_keys",
  },
};

/** The providers, in the order they are offered. */
export const LISTED: ProviderId[] = [
  "anthropic", "openai", "google", "openrouter", "groq", "mistral", "xai", "deepseek",
];

/** Strip what a paste drags along: whitespace, quotes, a "Bearer " prefix. */
export function cleanKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
}

export interface Detection {
  /** Providers this key could belong to, most likely first. */
  candidates: ProviderId[];
  /** True when a distinctive prefix names exactly one provider. */
  sure: boolean;
}

/** The provider from the key's shape alone; never probed, as that would leak it to others. */
export function detect(key: string): Detection {
  const k = cleanKey(key);
  const one = (id: ProviderId): Detection => ({ candidates: [id], sure: true });
  if (/^sk-ant-/.test(k)) return one("anthropic");
  if (/^sk-or-/.test(k)) return one("openrouter");
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) return one("google");
  if (/^gsk_/.test(k)) return one("groq");
  if (/^xai-/.test(k)) return one("xai");
  if (/^sk-(proj|svcacct|admin)-/.test(k)) return one("openai");
  // DeepSeek keys are `sk-` plus 32 hex digits; the shape sets the order, not the answer.
  if (/^sk-[0-9a-f]{32}$/.test(k)) return { candidates: ["deepseek", "openai"], sure: false };
  if (/^sk-/.test(k)) return { candidates: ["openai", "deepseek"], sure: false };
  if (/^[A-Za-z0-9]{32}$/.test(k)) return { candidates: ["mistral"], sure: false };
  return { candidates: [], sure: false };
}

/** Enough of a key to recognise it, never enough to use it. */
export function maskKey(key: string): string {
  const k = cleanKey(key);
  if (k.length <= 12) return "…" + k.slice(-2);
  const head = k.match(/^[A-Za-z]+[-_](?:[a-z]+-)?/)?.[0] ?? k.slice(0, 4);
  return `${head.slice(0, 8)}…${k.slice(-4)}`;
}
