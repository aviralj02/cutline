import type { Provider } from "./providers";

/** Every way a model request fails, grouped by its fix; both wires reduce to this. */
export type Failure =
  | "key" | "access" | "model" | "none" | "credit" | "rate" | "busy"
  | "network" | "refused" | "tools" | "aborted" | "other";

export class AiError extends Error {
  constructor(
    readonly kind: Failure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** Classify by status and message: Google sends 400 for a bad key, OpenAI 429 for no credit. */
export function classify(status: number, message = "", code = ""): AiError {
  const m = `${message} ${code}`.toLowerCase();
  const kind: Failure =
    status === 401 || /api key not valid|invalid api key|incorrect api key|invalid x-api-key|invalid_api_key/.test(m)
      ? "key"
      : status === 402 || /insufficient_quota|credit balance|out of credit|exceeded your current quota|billing|payment required/.test(m)
        ? "credit"
        : status === 403
          ? "access"
          : status === 404
            ? "model"
            : status === 429
              ? "rate"
              : /(not support|unsupported)[^.]{0,40}tool|tool[^.]{0,40}(not supported|unsupported)/.test(m)
                ? "tools"
                : status >= 500
                  ? "busy"
                  : "other";
  return new AiError(kind, message || `HTTP ${status}`, status);
}

export interface Explained {
  kind: Failure;
  /** What went wrong. */
  title: string;
  /** What to do about it. */
  fix: string;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Say what went wrong and how to fix it, in the provider's own name. */
export function explain(err: unknown, provider: Provider, model?: string): Explained {
  const e =
    err instanceof AiError ? err : new AiError("other", err instanceof Error ? err.message : String(err));
  const p = provider.name;
  const m = model ?? "that model";
  const say = (title: string, fix: string): Explained => ({ kind: e.kind, title, fix });
  switch (e.kind) {
    case "key":
      return say(`${p} didn't accept this key.`, "Check it was copied whole, or make a new one.");
    case "access":
      return say(`This key isn't allowed to use ${m}.`, "Choose another model, or give the key access to it.");
    case "model":
      return say(`${p} has no model called ${m}.`, "Choose another model.");
    case "none":
      return say(`${p} lists no models this key can edit with.`, "Check the key's permissions, or use another key.");
    case "credit":
      return say(`This ${p} account is out of credit.`, "Add credit to the account, or connect a different key.");
    case "rate":
      return say(`${p} is rate-limiting this key.`, "Wait a moment, then ask again.");
    case "busy":
      return say(`${p} is overloaded or down right now.`, "Try again in a minute.");
    case "network":
      return say(`Couldn't reach ${p}.`, "Check your connection, then try again.");
    case "refused":
      return say(`${m} declined this request.`, clip(e.message) || "Rephrase it, or choose another model.");
    case "tools":
      return say(`${m} can't call tools, and Cutline edits through them.`, "Choose another model.");
    case "aborted":
      return say("Stopped.", "Nothing was changed.");
    default:
      return say(`${p} returned an error.`, clip(e.message));
  }
}
