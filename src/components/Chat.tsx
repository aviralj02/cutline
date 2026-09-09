"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { IconButton, PanelHeader, SendIcon } from "@/components/ui";

const SUGGESTIONS = [
  "Cut all the silences",
  "Trim to 30 seconds",
  "Drop the first 5 seconds",
  "Title the opening “Intro”",
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

  const conversation = chat.filter((e) => e.role !== "system");
  // Facts about the footage, not turns in the conversation. They stay put
  // above the thread rather than scrolling away with it.
  const notes = chat.filter((e) => e.role === "system");

  return (
    /* Before a conversation starts this panel is only as tall as its content,
       so the version history — the thing that makes Cutline different — gets
       the rest of the rail instead of empty space. */
    <div className={`flex min-h-0 flex-col ${conversation.length ? "flex-1" : "shrink-0"}`}>
      <PanelHeader title="Ask" />

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
              It read the audio while importing, so it already knows where the pauses are.
            </p>
            <div className="mt-3 flex flex-col items-start gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  disabled={busy}
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
                      <div key={i} className="flex items-baseline gap-2 text-[12px] text-ink-2">
                        <span className="h-1 w-1 shrink-0 translate-y-[-2px] rounded-full bg-leader" />
                        <span>{step}</span>
                      </div>
                    ))}
                    {entry.text && (
                      <p className={entry.failed ? "text-grease" : "text-ink"}>{entry.text}</p>
                    )}
                    {!entry.text && !entry.steps?.length && busy && (
                      <p className="animate-pulse text-[12px] text-ink-3">Reading the timeline…</p>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        className="border-t border-edge p-2.5"
      >
        <div className="flex items-end gap-2 rounded-ctl border border-edge bg-raised px-3 py-2 transition-colors focus-within:border-leader/60">
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
            placeholder="Cut all the silences"
            disabled={busy}
            className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-[22px] text-ink outline-none placeholder:text-ink-3"
          />
          <IconButton
            type="submit"
            variant="primary"
            round
            disabled={busy || !value.trim()}
            icon={<SendIcon size={15} />}
            label="Send"
            className="!h-8 !w-8"
          />
        </div>
      </form>
    </div>
  );
}
