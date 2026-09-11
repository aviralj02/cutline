"use client";

import { useMemo, useState } from "react";
import { useAi } from "@/lib/ai/session";
import { cleanKey, detect, LISTED, PROVIDERS, type ProviderId } from "@/lib/ai/providers";
import { Button, KeyIcon, Segmented, WorkingIcon } from "@/components/ui";

/** Key entry in the composer's slot, which the composer takes over on connect. */
export default function ConnectCard() {
  const connect = useAi((s) => s.connect);
  const checking = useAi((s) => s.checking);
  const problem = useAi((s) => s.problem);
  const clearProblem = useAi((s) => s.clearProblem);

  const [raw, setRaw] = useState("");
  const [picked, setPicked] = useState<ProviderId | null>(null);
  const [remember, setRemember] = useState(true);

  const key = cleanKey(raw);
  const found = useMemo(() => detect(key), [key]);
  // A known prefix decides; otherwise the user picks from the candidates, or from every provider.
  const choices = found.candidates.length > 1 ? found.candidates : LISTED;
  const provider: ProviderId | null = found.sure
    ? found.candidates[0]
    : picked && choices.includes(picked)
      ? picked
      : (found.candidates[0] ?? null);
  const name = provider ? PROVIDERS[provider].name : null;
  const ready = !!key && !!provider;

  const submit = () => {
    if (!ready || checking || !provider) return;
    void connect({ provider, key, remember });
  };

  return (
    <form
      aria-label="Connect a model"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-edge p-2.5"
    >
      {/* Same 38px as the composer, so the slot keeps its height on connect. */}
      <label className="flex h-9.5 items-center gap-2 rounded-ctl border border-edge bg-raised px-3 transition-colors focus-within:border-leader/60">
        <KeyIcon size={14} className="shrink-0 text-ink-3" />
        {/* Masked, since screens get shared; the provider name is the feedback. */}
        <input
          type="password"
          aria-label="API key"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            clearProblem();
          }}
          placeholder="Paste an API key"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-ink-3"
        />
        {found.sure && name && (
          <span key={name} className="rise-in shrink-0 text-[11.5px] text-ink-2" aria-live="polite">
            {name}
          </span>
        )}
      </label>

      {key && !found.sure && (
        <div className="rise-in mt-2">
          <p className="mb-1.5 text-[12px] leading-relaxed text-ink-2">
            {found.candidates.length > 1
              ? "Keys from these look alike. Which one issued it?"
              : found.candidates.length
                ? "This looks like a Mistral key. Change it if not."
                : "Which provider issued this key?"}
          </p>
          <Segmented
            label="Provider"
            options={choices}
            value={provider}
            onChange={(p) => {
              setPicked(p);
              clearProblem();
            }}
            format={(p) => PROVIDERS[p].name}
            mono={false}
            wrap
          />
        </div>
      )}

      {/* Only once there is a key; a disabled primary is a loud slab that says nothing. */}
      {key && (
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={!ready || checking}
          icon={checking ? <WorkingIcon size={14} /> : undefined}
          className="rise-in mt-2 w-full"
        >
          {checking ? "Checking the key" : name ? `Connect to ${name}` : "Connect"}
        </Button>
      )}

      {problem && (
        <div role="alert" className="rise-in mt-2 text-[12px] leading-relaxed">
          <p className="text-grease">{problem.title}</p>
          <p className="text-ink-2">{problem.fix}</p>
        </div>
      )}

      <label className="mt-2.5 flex w-fit cursor-pointer items-center gap-1.5 text-[12px] text-ink-2">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="h-3.5 w-3.5 accent-leader"
        />
        Remember on this device
      </label>

      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
        Your key stays in this browser and goes straight to {name ?? "the provider"}. Cutline has no
        server in between.
        {name && provider && (
          <>
            {" "}
            <a
              href={PROVIDERS[provider].keyUrl}
              target="_blank"
              rel="noreferrer"
              className="text-ink-2 underline decoration-ink-3/60 underline-offset-2 transition-colors hover:text-ink"
            >
              Get a key from {name}
            </a>
          </>
        )}
      </p>
    </form>
  );
}
