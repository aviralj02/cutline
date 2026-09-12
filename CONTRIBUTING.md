# Contributing to Cutline

Thanks for looking. Cutline is a video editor that runs entirely in the
browser, and contributions of every size are welcome - a bug report with a clip
that reproduces it is as useful as a pull request.

## Getting set up

```bash
bun install
bun dev
```

No environment file, no keys, no services. Drop an MP4 or WebM onto the start
screen and you are editing. To exercise the agent you paste your own API key
into the Ask panel; it goes to that provider and nowhere else.

Read **[ARCHITECTURE.md](./ARCHITECTURE.md)** first. It is short, it explains
how a browser video editor works, and it spells out every acronym. The single
most useful thing to understand before changing anything is that the edit is a
JSON document and everything else reads it.

## Before you open a pull request

```bash
bunx tsc --noEmit -p .      # types
bun test                    # unit tests
node test/e2e/verify.mjs     # the browser suite, with `bun dev` running
```

The browser suite drives real Chrome and records its own test footage, so it
needs the dev server on `localhost:3000`. It is the check that catches the
things unit tests cannot: an effect that never reaches the picture, a control
that draws nothing, a layout that steals clicks.

**New behaviour needs a test that would fail without it.** If you fix a bug,
the best pull request contains the check that goes red on the old code.

## The rules that matter

These are not style preferences; each one is load-bearing, and
[CLAUDE.md](./CLAUDE.md) explains why in more detail.

- **Nothing uploads, and there is no server.** The agent loop, decoding,
  analysis and export all run in the page. A proxy or a hosted endpoint would
  break the promise the product is built on.
- **Edit operations are pure.** Everything in `src/lib/edl/ops.ts` takes a
  document and returns a new one, with no I/O, and ends in `normalize()` so
  times snap to frames. That is what lets the agent's tools be the same
  functions your clicks call.
- **Source time and timeline time are different clocks.** Mixing them up is the
  most common bug in this codebase. Convert through `src/lib/edl/query.ts`.
- **One renderer.** `composeFrame` draws a frame for both the preview and the
  export. Do not add a second copy of that maths.
- **Compose the UI primitives** in `src/components/ui` rather than hand-rolling
  a control, and use the colour tokens — amber means the agent or the primary
  action, red means destruction, and nothing else uses them.
- **Comments are one line.** If the reasoning needs a paragraph, it belongs in
  CLAUDE.md or ARCHITECTURE.md.

## Adding a model provider

A provider is only listed once it has been checked with a real browser
preflight carrying the headers its client sends. Cutline never tries a key
against providers to discover who issued it — the prefix decides, and a
look-alike becomes a choice the user makes. If a provider you want is missing,
say which one and whether its API allows browser requests.

## Reporting a bug

Video bugs are specific. The most helpful report says what the footage was
(container, codec, roughly how long, where it came from), what you did, what
happened, and what you expected. A screenshot of the timeline usually says more
than a paragraph. If a file reproduces it and you can share it, that is ideal —
but never share footage you would not want public.
