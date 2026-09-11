import type { ModelInfo } from "./models";
import { PROVIDERS, type ProviderId } from "./providers";

/** The key and its model, in this browser only: localStorage if remembered, else sessionStorage. */
export interface Connection {
  provider: ProviderId;
  key: string;
  model: ModelInfo;
  remember: boolean;
}

const SLOT = "cutline.ai";

function stores(): { local: Storage | null; session: Storage | null } {
  try {
    return { local: window.localStorage, session: window.sessionStorage };
  } catch {
    // Storage disabled or blocked; the connection lives in memory only.
    return { local: null, session: null };
  }
}

const valid = (c: unknown): c is Connection => {
  const x = c as Partial<Connection> | null;
  return (
    !!x && typeof x.provider === "string" && x.provider in PROVIDERS &&
    typeof x.key === "string" && typeof x.model?.id === "string"
  );
};

export function loadConnection(): Connection | null {
  const { local, session } = stores();
  for (const s of [local, session]) {
    try {
      const raw = s?.getItem(SLOT);
      if (!raw) continue;
      const c = JSON.parse(raw) as unknown;
      if (valid(c)) return c;
    } catch {
      /* unreadable; treat as absent */
    }
  }
  return null;
}

export function saveConnection(c: Connection): void {
  const { local, session } = stores();
  try {
    (c.remember ? session : local)?.removeItem(SLOT);
    (c.remember ? local : session)?.setItem(SLOT, JSON.stringify(c));
  } catch {
    /* quota or privacy mode; the connection still works for this session */
  }
}

export function forgetConnection(): void {
  const { local, session } = stores();
  try {
    local?.removeItem(SLOT);
    session?.removeItem(SLOT);
  } catch {
    /* nothing to remove */
  }
}
