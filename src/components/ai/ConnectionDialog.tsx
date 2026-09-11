"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAi } from "@/lib/ai/session";
import { maskKey, PROVIDERS } from "@/lib/ai/providers";
import { Button, CheckIcon, Checkbox, Dialog, SearchIcon, WorkingIcon } from "@/components/ui";

/** Model and key modal: the search leads and picking closes; the key sits in the footer band. */
export default function ConnectionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const conn = useAi((s) => s.conn);
  const models = useAi((s) => s.models);
  const listing = useAi((s) => s.listing);
  const problem = useAi((s) => s.problem);
  const loadModels = useAi((s) => s.loadModels);
  const setModel = useAi((s) => s.setModel);
  const setRemember = useAi((s) => s.setRemember);
  const forget = useAi((s) => s.forget);

  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // Fetched on opening, never on page load: the key is used only when the user acts.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    void loadModels();
  }, [open, loadModels]);

  const current = conn?.model.id;
  const all = models.length ? models : conn ? [conn.model] : [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
  }, [all, query]);

  // The highlight starts on the model in use, and follows the filter.
  useEffect(() => {
    const i = shown.findIndex((m) => m.id === current);
    setActive(query || i < 0 ? 0 : i);
  }, [shown, current, query]);

  const optionId = (i: number) => `${id}-model-${i}`;
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId derives from a stable id
  }, [active, open]);

  if (!conn) return null;
  const provider = PROVIDERS[conn.provider];

  const pick = (model: string) => {
    setModel(model);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Model and key"
      closeLabel="Close"
      initialFocus={search}
      className="w-[26rem] max-w-[calc(100vw-2rem)]"
    >
      <p className="mt-0.5 flex items-baseline gap-2 px-4 text-[12.5px] text-ink-2">
        {provider.name}
        <span className="tnum min-w-0 truncate font-mono text-[11.5px] text-ink-3">{maskKey(conn.key)}</span>
      </p>

      <div className="px-4 pb-4 pt-3.5">
        <div className="overflow-hidden rounded-ctl border border-edge bg-raised/50 transition-colors focus-within:border-leader/60">
          <label className="flex h-9.5 items-center gap-2 border-b border-edge px-3">
            <SearchIcon size={14} className="shrink-0 text-ink-3" />
            <input
              ref={search}
              role="combobox"
              aria-label="Search models"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? optionId(active) : undefined}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setActive((i) => (shown.length ? (i + d + shown.length) % shown.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (shown[active]) pick(shown[active].id);
                }
              }}
              placeholder={all.length > 1 ? `Search ${all.length} models` : "Search models"}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
            {listing && <WorkingIcon size={13} className="shrink-0 text-ink-3" />}
          </label>

          <ul id={`${id}-list`} role="listbox" aria-label="Models" className="max-h-64 overflow-y-auto p-0.5">
            {shown.map((m, i) => {
              const chosen = m.id === current;
              return (
                <li
                  key={m.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={chosen}
                  // Keep focus in the search, so mouse and keyboard share one highlight.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(m.id)}
                  onMouseMove={() => setActive(i)}
                  className={`flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2.5 transition-colors duration-100 ${
                    i === active ? "bg-white/[.07]" : ""
                  }`}
                >
                  <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${chosen ? "text-ink" : "text-ink-2"}`}>
                    {m.id}
                  </span>
                  {m.name !== m.id && (
                    <span className="max-w-[45%] shrink-0 truncate text-[11.5px] text-ink-3">{m.name}</span>
                  )}
                  <CheckIcon size={13} className={`shrink-0 text-leader ${chosen ? "" : "invisible"}`} />
                </li>
              );
            })}
            {!shown.length && (
              <li className="px-2.5 py-2 text-[12px] text-ink-3">
                {listing ? "Fetching the models this key can use" : `No model matches “${query.trim()}”`}
              </li>
            )}
          </ul>
        </div>

        {problem && (
          <p role="alert" className="mt-2.5 text-[12px] leading-relaxed">
            <span className="text-grease">{problem.title}</span> <span className="text-ink-2">{problem.fix}</span>
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-edge bg-white/[.02] px-4 py-1.5">
        <Checkbox
          checked={conn.remember}
          onChange={setRemember}
          label="Remember on this device"
          hint={conn.remember ? "Kept in this browser until you forget it." : "Forgotten when this tab closes."}
          className="min-w-0 flex-1"
        />
        <Button
          variant="danger"
          title="Remove the key from this browser"
          onClick={() => {
            onClose();
            forget();
          }}
        >
          Forget key
        </Button>
      </div>
    </Dialog>
  );
}
