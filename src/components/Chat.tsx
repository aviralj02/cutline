"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";

const SUGGESTIONS = [
  "Cut all the silences",
  "Trim this to 30 seconds",
  "Remove the first 5 seconds",
  "Add a title that says Intro for the first 3 seconds",
];

export default function Chat() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.busy);
  const ask = useStore((s) => s.ask);
  const [value, setValue] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setValue("");
    void ask(t);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
        <span className="h-1.5 w-1.5 rounded-full bg-[#f5b544]" />
        <span className="text-[11px] font-medium tracking-wide text-white/50">EDITOR</span>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {chat.length === 0 && (
          <p className="text-xs leading-relaxed text-white/35">
            Describe the edit you want. Every change becomes a version you can restore.
          </p>
        )}

        {chat.map((entry) => (
          <div key={entry.id} className="text-[13px] leading-relaxed">
            {entry.role === "you" && (
              <div className="ml-auto w-fit max-w-[90%] rounded-lg rounded-br-sm bg-white/8 px-3 py-2 text-white/90">
                {entry.text}
              </div>
            )}

            {entry.role === "system" && (
              <div className="rounded-md border border-white/8 bg-white/[.03] px-3 py-2 text-xs text-white/45">
                {entry.text}
              </div>
            )}

            {entry.role === "agent" && (
              <div className="space-y-1.5">
                {entry.steps?.map((step, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-white/45">
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[#f5b544]" />
                    <span>{step}</span>
                  </div>
                ))}
                {entry.text && (
                  <p className={entry.failed ? "text-[#e88b7d]" : "text-white/80"}>{entry.text}</p>
                )}
                {!entry.text && !entry.steps?.length && busy && (
                  <p className="animate-pulse text-xs text-white/35">Thinking…</p>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {chat.length <= 1 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              disabled={busy}
              className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-white/50 transition hover:border-[#f5b544]/50 hover:text-[#f5b544] disabled:opacity-30"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        className="border-t border-white/8 p-3"
      >
        <div className="flex items-end gap-2 rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/8 focus-within:ring-[#f5b544]/40">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(value);
              }
            }}
            rows={1}
            placeholder="Cut all the silences…"
            disabled={busy}
            className="max-h-28 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] text-white/90 outline-none placeholder:text-white/25"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="shrink-0 rounded-md bg-[#f5b544] px-2.5 py-1 text-[11px] font-medium text-black transition hover:bg-[#ffc65e] disabled:opacity-25"
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
