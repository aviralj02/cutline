"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useAi } from "@/lib/ai/session";
import { LISTED, PROVIDERS } from "@/lib/ai/providers";
import { Button, ChevronIcon, IconButton, PanelHeader, SendIcon, StopIcon } from "@/components/ui";
import ConnectCard from "./ai/ConnectCard";
import ConnectionDialog from "./ai/ConnectionDialog";

const SUGGESTIONS = [
  "Cut all the silences",
  "Trim to 30 seconds",
  "Drop the first 5 seconds",
  "Title the opening “Intro”",
];

const names = LISTED.map((id) => PROVIDERS[id].name);
const PROVIDER_LIST = `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

export default function Chat() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.busy);
  const ask = useStore((s) => s.ask);
  const stop = useStore((s) => s.stop);
  const conn = useAi((s) => s.conn);
  const hydrated = useAi((s) => s.hydrated);
  const hydrate = useAi((s) => s.hydrate);
  const forget = useAi((s) => s.forget);
  const [value, setValue] = useState("");
  const [choosing, setChoosing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Storage is read after mount; reading it during render is a hydration error.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!conn) setChoosing(false);
  }, [conn]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat]);

  // Escape stops a running request; registered once and read through a ref, like every global shortcut.
  const running = useRef({ busy, stop });
  useEffect(() => {
    running.current = { busy, stop };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && running.current.busy) running.current.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy || !conn) return;
    setValue("");
    void ask(t);
  };

  const conversation = chat.filter((e) => e.role !== "system");
  // Facts about the footage, not turns in the conversation. They stay put
  // above the thread rather than scrolling away with it.
  const notes = chat.filter((e) => e.role === "system");

  return (
    /* Before a conversation starts this panel is only as tall as its content,
       so the version history — the thing that makes Cutline different — gets
       the rest of the rail instead of empty space. */
    <div className={`flex min-h-0 flex-col ${conversation.length ? "flex-1" : "shrink-0"}`}>
      <PanelHeader title="Ask">
        {conn && (
          <Button
            onClick={() => setChoosing(true)}
            aria-haspopup="dialog"
            aria-label={`Model: ${conn.model.id}. Change the model or the key`}
            title="Change the model or the key"
            className="min-w-0 max-w-[12rem] !gap-1 !px-2"
          >
            <span className="min-w-0 truncate font-mono text-[11.5px]">{conn.model.id}</span>
            <ChevronIcon size={13} className="shrink-0 text-ink-3" />
          </Button>
        )}
      </PanelHeader>

      {conn && <ConnectionDialog open={choosing} onClose={() => setChoosing(false)} />}

      {notes.length > 0 && (
        <div className="border-b border-edge px-3 py-2.5">
          {notes.map((n) => (
            <p
              key={n.id}
              className={`text-[12px] leading-relaxed ${n.failed ? "text-grease" : "text-ink-2"}`}
            >
              {n.text}
            </p>
          ))}
        </div>
      )}

      <div className={`min-h-0 overflow-y-auto ${conversation.length ? "flex-1" : ""}`}>
        {conversation.length === 0 ? (
          /* Grouped, not centred in the panel — a lone sentence floating in
             empty space reads as a loading state, not an invitation. */
          <div className="px-3 pt-4">
            <p className="text-[13px] text-ink">Tell Cutline what to change.</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
              {conn
                ? "It read the audio while importing, so it already knows where the pauses are."
                : `Bring your own key from ${PROVIDER_LIST}.`}
            </p>
            <div className="mt-3 flex flex-col items-start gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  disabled={busy || !conn}
                  title={conn ? undefined : "Connect a model first"}
                  className="rounded-ctl border border-edge px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-[background-color,border-color,color,transform] duration-150 hover:border-leader/50 hover:bg-white/[.04] hover:text-ink active:scale-[.98] disabled:opacity-35"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-3 py-3">
            {conversation.map((entry) => (
              <div key={entry.id} className="text-[13px] leading-relaxed">
                {entry.role === "you" ? (
                  <p className="ml-auto w-fit max-w-[92%] rounded-ctl rounded-br-[2px] bg-raised px-2.5 py-1.5 text-ink">
                    {entry.text}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {entry.steps?.map((step, i) => (
                      <div
                        key={i}
                        className={`flex items-baseline gap-2 text-[12px] ${
                          // Stopped steps were never applied: struck through, not hidden.
                          entry.stopped ? "text-ink-3 line-through" : "text-ink-2"
                        }`}
                      >
                        <span
                          className={`h-1 w-1 shrink-0 translate-y-[-2px] rounded-full ${
                            entry.stopped ? "bg-ink-3" : "bg-leader"
                          }`}
                        />
                        <span>{step}</span>
                      </div>
                    ))}
                    {entry.text && (
                      <p
                        className={
                          entry.failed ? "text-grease" : entry.stopped ? "text-ink-2" : "text-ink"
                        }
                      >
                        {entry.text}
                      </p>
                    )}
                    {entry.fix && <p className="text-[12.5px] text-ink-2">{entry.fix}</p>}
                    {entry.failed && (entry.kind === "key" || entry.kind === "credit") && (
                      <Button onClick={forget} className="-ml-2.5">
                        Connect a different key
                      </Button>
                    )}
                    {entry.failed &&
                      (entry.kind === "model" || entry.kind === "access" || entry.kind === "tools") && (
                        <Button onClick={() => setChoosing(true)} className="-ml-2.5">
                          Choose another model
                        </Button>
                      )}
                    {!entry.text && !entry.steps?.length && busy && (
                      <p className="animate-pulse text-[12px] text-ink-3">Reading the timeline…</p>
                    )}
                    {entry.model && !entry.failed && (entry.text || entry.steps?.length) && (
                      <p className="font-mono text-[10.5px] text-ink-3">{entry.model}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {!hydrated ? null : conn ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(value);
          }}
          className="rise-in border-t border-edge p-2.5"
        >
          {/* One line; the nested button keeps its corner concentric with the field's. */}
          <div className="flex items-center gap-1 rounded-ctl border border-edge bg-raised p-0.5 pl-3 transition-colors focus-within:border-leader/60">
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label="Ask for an edit"
              placeholder={busy ? "Working. Escape stops it." : "Cut all the silences"}
              disabled={busy}
              autoComplete="off"
              className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />
            {/* One slot: send while idle, stop while working. */}
            {busy ? (
              <IconButton variant="primary" nested icon={<StopIcon size={11} />} label="Stop" onClick={stop} />
            ) : (
              <IconButton
                type="submit"
                variant="primary"
                nested
                disabled={!value.trim()}
                icon={<SendIcon size={15} />}
                label="Send"
              />
            )}
          </div>
        </form>
      ) : (
        <ConnectCard />
      )}
    </div>
  );
}
