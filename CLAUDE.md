@AGENTS.md

# Cutline

A browser video editor where the edit is a document, an agent edits that
document, and every change is a version. Nothing uploads.

**Positioned as: a video editor with version control and no sign-up, that is
easy to use by hand — with AI available on your own key if you want it.**
Not as an AI-native editor: the whole editor works with no key and no agent,
and public copy leads with manual editing, versions and no sign-up, with the
agent named after them as an option. Those claims are also constraints: an
account, a hosted project store, a server proxy, or a feature reachable only
by asking would each break one of them.

**[ARCHITECTURE.md](./ARCHITECTURE.md)** is the short guide to how it works:
the edit document, the two clocks, how preview reads the edit each frame, where
decoding happens, versions, the agent, and a glossary with every acronym
spelled out. Read it before touching the render pipeline or the coordinate
conversions.

## Architecture, in one paragraph

The edit is plain JSON (`src/lib/edl/types.ts`). Everything follows from that:
the agent's tools are pure functions over it, version control snapshots it, and
preview *interprets* it rather than rendering it. The video track is contiguous
by construction — clips play back to back in array order and no clip stores its
timeline position, so a ripple edit touches one array entry instead of
rewriting `at` on every clip after it. Empty space is an entry
too: a gap is a *slug*, a clip of blank leader (`isSlug`).

Two coordinate systems run through the codebase and mixing them is the main
hazard: **source time** (seconds into an original file) and **timeline time**
(seconds into the edit). `src/lib/edl/query.ts` owns every conversion.

```
src/lib/edl/       model, pure ops, coordinate queries   ← read this first
src/lib/vcs/       commit DAG, branches, semantic diff
src/lib/media/     OPFS store, demux probe, silence detection
src/lib/agent/     tool schemas + dispatcher: pure functions over the document
src/lib/ai/        bring-your-own-key: providers, the agent loop, two wires
src/components/ui/ design primitives — compose these, don't restyle
```

## Code style

- **Comments are one line.** State the why in a single short line, or leave
  the comment out. Reasoning that needs a paragraph belongs in this file or
  ARCHITECTURE.md, not in the code. Older files still carry long blocks; do
  not match them.

## The agent: bring your own key

Cutline is open source and ships no model access of its own. The user pastes
a key from Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, Mistral, xAI or
DeepSeek. Keys only — there is no custom endpoint, by decision: every provider
on the list has had its browser access checked, and an arbitrary URL cannot be.

- **The loop runs in the browser; there is no server route.** The tools are
  pure functions over the document, so nothing about an edit needs a server —
  and without one, a key goes from the tab to its provider and nowhere else.
  That sentence is the product's promise; do not add a proxy that breaks it.
- **A provider is only listed if it answers a browser's CORS preflight.**
  Every one in `PROVIDERS` was checked with a real preflight carrying the
  headers its client sends. Adding one means checking first, not assuming.
- **Never try a key against providers to find out whose it is.** That hands a
  secret to companies it was not issued by. `detect()` reads the prefix; a
  look-alike (a bare `sk-` is OpenAI or DeepSeek) becomes a choice the user
  makes, and the button names where the key will go.
- **Two wires, and the loop does not know which.** Anthropic goes through the
  official SDK (`dangerouslyAllowBrowser` — the key is the user's own).
  Everyone else speaks OpenAI chat-completions over `fetch`. Each implements
  `Conversation` and keeps its transcript in its own shape: Anthropic's
  thinking blocks travel back verbatim, while an OpenAI-compatible assistant
  message is *rebuilt*, never echoed — some providers reject their own
  reasoning traces sent back.
- **Shape each request from what the model reports.** Adaptive thinking or
  `effort` sent to a model without them is a 400, so Anthropic's
  `capabilities` decide. Refusal fallbacks (`fallbacks: "default"`) go only to
  `claude-opus-5` and `claude-fable-5-1`. After a fallback, the declining
  model's thinking and tool calls before the boundary are dropped, and its
  calls never run.
- **The key lives in this browser, unencrypted, on purpose.** localStorage
  when remembered, sessionStorage otherwise. Encrypting it next to its own
  decryption key would be a promise the app cannot keep. It is never written
  into the project record, and New project leaves it alone.
- **Models are listed when the user acts** — on connect, where the listing
  *is* the key check, and when the model dialog opens. Never on page load.
- **One version per request; Stop applies nothing.** An aborted run throws,
  so a half-made edit never lands. The stopped steps stay visible, struck
  through, so it is clear what did not happen.
- **Every failure is one of a dozen kinds** (`Failure`), each with a title and
  a fix in the provider's own name. Classify by status *and* message: Google
  answers a bad key with a 400, OpenAI an empty account with a 429.
- **Built for loose requests.** Every manual action has a tool, and nothing
  the agent can do is out of reach by hand. The model is told the playhead,
  the selection and the last change, so "here", "this" and "undo" mean
  something (`revert_last_change` restores the version before, as a new
  version). Clips are listed with the numbers the user sees, and the system
  prompt maps everyday phrasing onto tools. A vague request gets the most
  reasonable edit plus one sentence naming the assumption, since every change
  is a version.
- **Test at the network edge.** Section 25e stands in for the providers with
  `page.route`, preflight included, so the SDK, CORS and storage all run on
  fake keys — and it checks that no key reaches any host but its own.

## Effect lanes

Fades and zooms live on lanes below the video track. Both are the same shape —
an interval with `at` and `dur` — so one drag model (move body, trim either
edge) covers every effect, and anything added later inherits it.

- **One lane per kind.** `addTrack` returns the document unchanged if that kind
  already exists, so it never appears in the history as a change and there is
  one place to look for a fade.
- **Rendering order is fixed:** zoom transforms the picture, titles ride above
  it unscaled, and the fade wash is painted last over everything. A caption
  that scales with a punch-in reads as a bug.
- **A zoom's focal point is set on the picture**, by dragging the target in
  `FocusPoint`, not by X/Y sliders. A zoom scales *about* that point, so it is
  the one place in frame that does not move as the scale changes — the marker
  sits exactly where it lands at any scale, and there is nothing to reconcile
  between the control and the result. The target maps through the crop window,
  so it stays correct on a reframed edit, and it takes arrow keys because it
  replaced controls that were keyboard-reachable.
- **The marker states its own centre unambiguously**: an unfilled ring with
  four ticks converging on a 3px core, and the scale readout parked in the
  frame corner. A filled disc reads as an *area* rather than a point, and a
  label hanging off it drags the eye off the true centre — which is what an
  apparent offset turns out to be, every time it has been reported.
- Lanes are sorted fade, zoom, then sound: the picture's lanes in the order
  they composite, and sound below them.
- **Sound is an interval too.** A sound item adds `src`, `in` (seconds into
  its file) and `srcDur`. Trimming its head advances `in`, so the music under
  the other edge stays put, and neither edge can run past the file. It plays
  through one `<audio>` element per item, driven by the frame loop and
  re-seeked only when it drifts more than 0.25s, so it never stutters.
- **Muting the original audio is a document flag** (`videoMuted`, stored only
  while on), so each toggle is a version you can undo. Sound lanes still play.

## Export

The edit becomes a file in the browser, through Mediabunny. Nothing uploads
here either, and the encode is the preview written down.

- **One renderer, used twice.** `lib/render/compose.ts` draws a frame; Preview
  calls it every animation frame and the exporter calls it for every frame of
  the file. A second copy of the crop-zoom-title-fade maths would drift from
  the one people judged their edit against, and the drift would only show up
  in the finished file — the worst possible place to find it.
- **The container is chosen from what the browser can encode**, never assumed.
  `getEncodableVideoCodecs` decides; MP4/H.264 wins when it is available
  because it plays everywhere. **Keeping the sound beats keeping the
  container:** a browser that encodes H.264 but not AAC writes WebM rather
  than a silent MP4. With no video encoder at all (Firefox Android) the dialog
  says so instead of failing mid-encode.
- **Audio is mixed a window at a time** (`WINDOW`, 5s), reading each source
  range fresh. Memory stays flat whatever the length, which is the same
  principle the import analysis follows — and the reason neither path decodes
  a whole file.
- **`plan.ts` is the document half and holds no browser APIs**, so what a
  window of sound is made of, whether a file needs an audio track, and which
  container to write are all unit-tested without a canvas or an encoder.
- **A clip's speed stretches the source range the audio reads**, exactly as it
  stretches the picture's timestamps. Sound and picture come apart otherwise,
  and only on sped-up clips.
- **Stop means stop.** The dialog's signal aborts the loop, and the output is
  cancelled rather than finalized, so a stopped export leaves no half-written
  file.
- **The export is frame-exact even though the preview is not.** Frames come
  from Mediabunny's `CanvasSink` (WebCodecs), not from the `<video>` element
  the preview draws, so it does not inherit the browser's ~50ms seek slop.
- **The finished file is held in memory** (`BufferTarget`), which is the known
  ceiling on a very long export. Writing straight to disk needs
  `showSaveFilePicker` and a `StreamTarget`, and that is the next thing to do
  here, not a rewrite of the loop.

## Discovery

It deploys to `https://cutline.heyaviral.com` and has exactly one route, so
the whole search surface is small — and therefore has to be exact.

- **`src/app/site.ts` is the only place the product describes itself.** The
  metadata, sitemap, robots, manifest and JSON-LD all read from it. Six copies
  of a tagline drift within a week.
- **The landing must render on the server.** `page.tsx` renders `Start` until
  a project loads rather than a "Loading" placeholder. That placeholder *was*
  the entire server response: no heading, no copy, no link, nothing to index —
  and most crawlers, nearly all LLM crawlers among them, never run the JS that
  would have filled it in. Do not put a loading gate above the landing again.
  The cost is that a returning project appears a moment after the landing,
  which is honest: until IndexedDB answers, nobody knows there is one.
- **`public/llms.txt` states the product in the words we want repeated**,
  including that Cutline is *not* "AI-native". Assistants quote this; keep it
  true, keep it short, and update it when the positioning moves.
- **`robots.ts` names the AI crawlers** as well as allowing `*`, because being
  quotable by an assistant is how a tool like this gets found now.
- **The OG card is a real screenshot of the landing's hero**
  (`app/opengraph-image.png`, 1200×630): the headline, the subhead and the
  gate, captured at 1000×525 and scaled 1.2 so it stays legible at thumbnail
  size, with the feature row and source chip hidden for the crop — at that
  height they land on the bottom edge, and a card that slices a control in
  half reads as a mistake. A real screenshot, not a synthetic graphic.
  Regenerate it when the landing changes.

## Rules that are load-bearing

- **Ops are pure.** Every function in `edl/ops.ts` returns a new document and
  performs no I/O. That is what lets the agent loop call them in the browser,
  and a test call them with a scripted model.
- **Snap to frames.** Every op ends in `normalize()`. Without it, float drift
  makes identical edits serialise differently and the version diffs go noisy.
- **Never commit a no-op.** `store.apply` compares against head first.
- **Drag gestures commit once.** Crop handles, effect drags and inspector
  sliders all write to `store.draft` and only commit on release. `useEdl()`
  returns the draft when one exists, so the preview updates live while the
  history gets exactly one entry per gesture. Committing per input event put
  ~100 near-identical versions in the history for one slider pull.
- **The inspector strip is always present**, showing a hint when nothing is
  selected. Letting it appear and disappear resized the timeline card, which
  shoved every lane upward the moment you added an effect — the timeline
  jumped out from under the cursor that had just used it.
- **Selection is exclusive:** one inspector, one subject. Selecting a clip
  clears the selected effect and the reverse.
- **A clip drag reorders; it does not reposition.** The track is contiguous by
  construction, so "move" can only mean "change places". The carried clip snaps
  into the slot the pointer is over rather than following the cursor freely —
  a clip floating between slots would imply the track can hold it there, and it
  cannot. `dropSlot()` picks the slot from the layout of the *other* clips,
  which is the one thing that does not move during the drag; measuring against
  the preview feeds the answer back into its own input and the order flickers
  between two slots. Under 4px of travel is still a click, so selecting a clip
  never shuffles the track.
- **A trim moves only the edge you drag.** Trimming a head in leaves a slug
  before the clip, trimming a tail in leaves one after it, and nothing else on
  the track moves. Dragging back out uses that gap first and stops at a
  neighbouring clip rather than pushing it; only the last clip's tail changes
  the edit's length. A slug plays as black, is never left at the end, and is
  closed by selecting it and deleting it. The ripple trim this replaced pulled
  every later clip along, so trimming a head read as the wrong edge moving.
- **Drags catch on the edit's own landmarks.** Every cut, both ends of the
  edit, the playhead and the other lanes' item edges pull a drag in from
  `SNAP_PX` (7) away. The threshold is in **pixels, not seconds**, so the pull
  feels identical at 1× and at 32× — and at a normal zoom one frame is a
  fraction of a pixel, which no hand can land on unaided. This is what keeps a
  fade on the cut it belongs to: a lane a few milliseconds off looks fine on
  the timeline and shows as a sliver in the export. **A dragged edge never
  catches on where it already sits** (`exceptId` for a lane item, and the clip
  trim drops its own boundary), or the handle reads as stuck for the first 7px.
  A catch that a clamp then overrode draws no guide, because nothing caught.
  `snap.ts` is pure, so all of it is tested without a pointer.
- **Register a global shortcut listener once.** `Timeline`'s keydown effect
  depended on `edl`, so it re-registered on every edit — and that silently ate
  every arrow key. `Transport` owns a window keydown listener too and mounts
  first, so it runs first, moves the playhead, and React flushes that
  synchronously; the flush re-ran the Timeline effect and removed its listener
  *while the same event was still being dispatched*. A listener removed
  mid-dispatch is never called. Keep the listener registered with `[]` deps and
  read current values through a ref.
- **Scrubbing lives on the ruler and nowhere else.** The track scrubbed as
  well while a clip was only ever something you selected. Once clips could be
  trimmed by dragging, one surface could not mean both "move the playhead" and
  "edit this clip" — the gesture would have to guess. The ruler is the single
  unambiguous time surface; everything below it edits. Clicking a clip selects
  it without seeking.
- **Undo removes the version; restore adds one.** `vcs.undo` steps back and
  deletes the entry, because leaving a change and its reversal behind turns the
  history into a log of mistakes rather than a list of states worth returning
  to. It refuses to delete a commit another branch still reaches. Redo lives in
  memory only (`store.redoStack`) and any new edit discards it.
- **Merge ranges before deleting many.** Overlapping ranges applied separately
  eat the content between them — exactly the input silence detection produces.
- **Analysis is stored raw.** Silence ranges are unpadded so the agent can
  retune thresholds per request without re-analysing audio.
- **Analysis streams; it never holds the audio.** `summariseAudio` decodes
  through Mediabunny's `AudioSampleSink` and folds each chunk into a loudness
  curve and a peak envelope — a few thousand numbers, whatever the length.
  `decodeAudio` (whole file to `arrayBuffer`, then `decodeAudioData`) is the
  fallback for codecs WebCodecs will not take, and it is why an hour of 48kHz
  stereo used to die on import at 1.4GB of decoded audio. Memory is now a
  function of duration alone, ~4MB an hour. Imports are capped at 4 GB
  (`MAX_FILE_BYTES`) to fit the footage people actually bring, not to protect
  memory. The whole-file fallback is the one path that holds a file in RAM, so
  it only runs up to 500 MB (`WHOLE_DECODE_MAX_BYTES`); a bigger file imports
  without silence analysis, and the import note says so.
- **Times are container seconds.** The streamed curve starts at the first hop
  that carries audio and adds that offset back (`AudioSummary.startSec`). An
  audio track rarely begins exactly with the video — a MediaRecorder capture
  starts about half a second in — and the hops before it hold no samples, so
  they read −180 dBFS and the detector calls the head of the file a pause.
  Container time is also the clock the video element seeks by, so it is the
  only frame in which a cut means anything.
- **The timeline holds its extent after a trim.** The ruler is drawn across
  `span = max(duration, held)`, not the duration. A trim that shortened the
  edit used to rescale the timeline under the hand doing the trimming: the
  clip kept its width as its content shrank, the pointer slid off the handle,
  and there was nowhere left to drag back out to. Fit records the current
  length rather than clearing the hold — zeroing it measures the next shrink
  against an already-shrinking draft and the timeline creeps a percent per
  trim.

## Design guidelines

The look comes from the cutting room, not from dark-SaaS convention. When
adding UI, follow these; if something here fights the work, change the guide
deliberately rather than drifting from it.

### Colour

Tokens live in `src/app/globals.css` under `@theme`. Use the token, never a
raw hex.

| Token | Use |
|---|---|
| `shell` / `panel` / `raised` / `edge` | Chrome. A genuinely neutral grey ramp — equal R/G/B, because a tinted UI contaminates the footage being judged next to it. |
| `mat` | The mid-grey immediately around the image. A black surround makes footage read brighter than it is; this is a working principle, not a style. |
| `ink` / `ink-2` / `ink-3` | Text, in descending emphasis. |
| `leader` | Film-leader amber. **The agent, and the primary action.** Nothing else. |
| `grease` | Grease-pencil red, after the china markers editors mark film with. **Cuts and destruction only** — never emphasis. |

Two accents, each with one fixed meaning. If a third seems necessary, the
hierarchy is probably wrong.

### Type

Archivo for interface, IBM Plex Mono for anything numeric. All timecode uses
the `Timecode` primitive, which carries `tnum` — digits must never reflow as
the playhead moves.

### Shape

Nothing is hard-cornered. Radius scales with the surface:

- 5px — checkbox faces; a 16px face at 7px reads as a circle.
- `--radius-sm` (7px) — clips, keycaps, segment buttons.
- `--radius-ctl` (10px) — buttons, inputs, menus.
- `--radius-gate` (14px) — the image, the track.
- `--radius-panel` (16px) — panels, the drop target.
- Full round — status chips, and transport controls only.

**Write `rounded-ctl`, never `rounded-[--radius-ctl]`.** Tailwind v4 generates
the named utility from the `--radius-*` theme namespace. The bracket form is
v3 shorthand that v4 dropped: it emits `border-radius: --radius-ctl`, which is
invalid CSS the browser discards without warning, so every control silently
renders square. The same applies to any `-[--var]` class — use the theme name,
or `(--var)` parentheses if there is no token. This shipped once and survived a
full design pass, a build, and a screenshot review before anyone caught it.

### Controls

Compose `Button`, `IconButton`, `Segmented` and `Checkbox` from `components/ui`. Do not
hand-roll a control: the speed row and the branch pills were both one-off
reimplementations of `Segmented` and drifted from it within a day. Targets are
32px minimum, hover is a translucent white wash so it reads identically on
every surface, and every control answers a press with a small scale-down.

**The transport floats over the timeline card on purpose.** It straddles at
`left-2/5` from `xl` up, where it is measured clear of the toolbar, and drops
into flow below that — the toolbar grows leftward when a clip is selected and
starts swallowing clicks meant for the speed control at around 1100px. Section
23 of the e2e checks, at every width down to the floor, that nothing under the
panel loses its clicks and nothing spills out of its row. Verify a floating
panel by measurement, not by looking at one width:
this read as "always broken" from a single narrow-window failure when it was
in fact fine at every size anyone works at.

**Confirm only what cannot be undone.** Everything in this app is undoable
except two things, and they are the only actions behind a `ConfirmDialog`:
`reset()`, which clears IndexedDB and OPFS outright, and deleting a variant,
which is not a commit and so leaves undo nothing to step back over — it takes
the versions only that variant reached with it (`vcs.onlyOn` counts them for
the dialog). Say what is at stake (how many versions, how
many files) rather than asking "are you sure", put focus on the safe choice,
and use the filled `destructive` variant so the dangerous button is the one
that looks dangerous.

**A modal `<dialog>` needs `m-auto`.** The UA centres it with
`inset: 0; margin: auto`, and Tailwind's preflight zeroes that margin — without
it the dialog pins to the top-left corner. Section 26 of the e2e asserts the
placement, because this is invisible to every other kind of check.

**Every modal composes `Dialog`**, which owns the native element, that
margin, focus on opening, Escape and the backdrop. `ConfirmDialog` is a
`Dialog` with two buttons; the model-and-key modal is another. A modal is for
a task that needs protected focus, not a place to park settings.

**A control inside a field keeps its corner concentric.** The composer's Send
sits 3px inside a 10px field (1px border, 2px padding), so it is
`IconButton nested`, at 7px — `--radius-sm`, the outer radius less the inset.
A full circle inside a rounded box reads as two unrelated shapes. Section 25e
measures it.

**Below 860px the editor shows a wall, not a smaller editor.** Cutting means
catching a 2px trim handle on a timeline measured in pixels per second; that
layout does not shrink gracefully, and a phone-sized version would be a worse
promise than an honest one. `DesktopOnly` states the window's own width
against the width needed, in the mono face the app uses for every other
measurement. `MIN_WIDTH` is measured, not a breakpoint: at 860 nothing spills
out of its row, no click is stolen, and the timeline toolbar keeps 51px to
spare with a clip selected — and it admits half a 1728px laptop screen. The
e2e's `FLOOR` constant must match it, so its narrowest measurements run at the
floor the product actually claims. Gate on a width measured after mount, never during render — the
server has no window and a tree that differs between the two is a hydration
error.

**No Unicode glyphs as icons.** A `⌫` in a keycap is not an icon system; use
`BackspaceIcon` from the lucide wrappers like everything else.

**Colour comes from `variant`, never from `className`.** Two Tailwind colour
utilities on one element tie on specificity, so the compiled order decides the
winner, not the order you wrote them. Passing `text-black` next to a component
default of `text-ink-2` lost that coin toss and shipped a grey play triangle on
an amber button. If a control needs a new colour treatment, add a variant.

### Icons

Icons come from **lucide-react**, wrapped in `components/ui/Icon.tsx` under
names describing the role they play here rather than the library's noun, so
swapping one is a single line. Do not author an SVG icon; if lucide lacks a
glyph, add the closest one and note it.

Four authored SVGs are deliberate and are not icons: the logo mark
(`ui/Logo.tsx`), its favicon (`app/icon.svg`), the timeline waveform, which is
geometry plotted from the actual audio, and `GithubIcon` — a brand mark, which
lucide does not carry. A link to the source is recognised by that shape or not
at all, so the closest generic glyph would defeat the point of showing it. That
is the exception, not a licence to draw icons.

### Waveforms

Bars are **DOM elements, not SVG rects.** The chart is stretched to each clip's
width, so an `rx` inside it is scaled unevenly per axis and renders as a
flattened ellipse; a CSS radius is in real pixels and stays round. They are
spaced at a fixed pixel pitch (`BAR_PITCH`) rather than a fixed count, so a
wide clip gets more bars instead of fatter ones — which is what keeps a full
round cap reading as softened rather than as a row of lozenges. The count comes
from a `ResizeObserver` on the track.

Bars cover the **visible slice at full density**, not the whole clip at a
capped count. Magnified, a clip is tens of thousands of pixels wide; capping
the count stretched every bar into a 50px block and left the part actually on
screen with a dozen of them. The window is quantised to `BAR_WINDOW`, so
scrolling redraws them every 400px rather than every frame, and the bar width
is a real pixel value so the pitch is the same at 1× and 32×.

Envelopes are normalised **per source file** against that file's own peak, and
drawn symmetric about the clip's centre line. Scaling by absolute amplitude
draws a normally recorded voice — which peaks around 0.18, nowhere near full
scale — as a flat 20% smudge that looks like a texture rather than audio. Files
peaking below 0.02 are left unscaled so room tone is not amplified into a
waveform that is not there.

### Motion

Motion is rare here and always answers something. There are three authored
moments and no others: a dialog arrives rather than blinks, the editor
assembles once after import (`gate-in`), and the start screen's sprocket strip
carries the state of the gate.

**The perforations are the start screen's motion system**, because they are the
one element that belongs to this product and no other. Still when there is no
film, advanced by exactly one pitch the moment a file is dragged over, running
while the import reads it, still again when it is done. A spinner would say
"working" in anyone's product; this says it in ours. The strip repeats on a
fixed pitch (`PITCH`, 21px — a hole plus its gap) so the loop has no seam, and
it is clipped by the gate rather than ending inside it.

The start screen settles in three steps — the claim, the gate, the detail —
with delay capped at 170ms. Longer reads as a performance rather than an
arrival, and every step starts from a visible default so a stylesheet that
never loads cannot hide the page. `prefers-reduced-motion` cuts all of it in
`globals.css`, which is why the import's status text has to carry the meaning
the running strip otherwise would.

**The gate draws its own focus ring.** Its file input is `sr-only`, so the
global `:focus-visible` outline lands on something nobody can see; without
`focus-within` on the label, the keyboard path to the one action on the screen
is invisible.

### Layout

The timeline is a card on the shell with a gutter around it, not the bottom
edge of the viewer. Its toolbar sits on a ruled band above the track so the
actions read as separate from the material they act on.

Ruler tick spacing is chosen from the **pixels available**, not from the
duration: the smallest interval in `TICK_STEPS` that leaves `MIN_TICK_PX`
between labels. Picking by duration alone meant slowing a clip stretched the
timeline without widening the ruler, so the same interval produced twice as
many labels and they overlapped by 3.4px on a narrow window. `MIN_TICK_PX` has
to cover **one and a half labels**, not one: the first label is left-aligned
rather than centred, so it spends half a label of the opening gap on itself.
At 68 that gap closed to 2.7px once a held extent changed the pitch.

The ruler and every lane live in **one horizontal scroller**, with the label
column `sticky left-0` inside it rather than as a second element scrolled in
sympathy — two scrollers drift by a pixel and the drift shows on a hairline.
Freeze it with `self-stretch`, never `h-full`: a percentage height against an
auto-height flex row collapses to the label's own 20px, which looked fine
until a lane started sliding underneath it. Magnification is expressed as how
many viewport widths the timeline spans (`SCALE_STEPS`), so 1× always means
"the whole edit at once" whatever the window or the footage.

**The rail's panels fold.** Ask and Versions each collapse from their heading
(`PanelHeader` with `open`/`onToggle`), apart or together, and the choice is
remembered per browser (`cutline.rail`). A folded panel is hidden, not
unmounted, so typed text survives; a folded Ask still shows the model and a
Working indicator while a request runs.

**Draw the scroll position; the platform will not.** macOS overlay scrollbars
occupy no layout — measured here as `offsetHeight - clientHeight === 0` — and
vanish at rest, so a timeline three screens wide looked like one screen that
stopped. The bar under the lanes is the width of the visible slice and drags
to move the view. A label sliding under the frozen column is hidden rather
than clipped: "0:05.00" cut at its centre reads as ".00".

### Contrast

`ink-3` is the floor, not a decorative grey. It must clear 4.5:1 on `raised`,
the lightest surface it lands on — it shipped once at 3.2:1. Check a new ink
value against `shell`, `panel` and `raised` before using it.

### Things not to do

These are the tells of generic UI, and the first version of this app had all of
them:

- Tracked-out ALL-CAPS eyebrow labels. Panel headings are sentence case at text
  size.
- Meta strings joined with middle dots. Use spacing, alignment or plain words.
- Colour used decoratively — the timeline once cycled five clip hues. Clips are
  the same material, so they are the same colour; colour marks *state*.
- Arrows appended to button text.
- One radius on everything.

### Words

Name things as a user would. Buttons say what happens and keep that name
through the flow. Empty screens say what to do next, never just what is
missing. Errors say what went wrong and how to fix it.

## Verification

```bash
bun test                    # 240 unit tests: edit algebra, effects, sound, trim and gaps, snapping, undo, variants, DSP, agent tools, export planning, BYOK
bun test/e2e/verify.mjs     # 246 checks in real Chrome — records its own test clip, and exports one back out
bun test/e2e/shots.mjs      # screenshots both screens for design review
```

The e2e script generates a clip with two deliberate silent stretches, so
analysis is checked against a known answer rather than a fixture.

**Screenshot the UI after changing it.** Several defects in this app's design
passes were only visible in a render — dark-on-dark perforations, a clipped
ruler label, a panel stretching into dead space, an icon button that rendered
as a blank disc.

Section 12 of the e2e guards the defects a screenshot catches only by luck: a
control that draws nothing, an icon-only control with no accessible name, a
text button whose computed corner radius is 0, and an icon under 3:1 against
its own button fill.

Section 24 covers the view model: that a trim leaves an untouched clip exactly
where it was (the witness for "the timeline did not rescale"), that the room a
trim opens can be trimmed back into, that magnification makes the track
scrollable and the position bar moves it, that the frozen label column stays
opaque over a scrolled lane, that ruler labels keep 6px of air at **every**
scale step, and that a narrow window gets the wall instead of a broken editor.

Section 13 measures the waveform's shape, not just its presence: peak height as
a fraction of the clip, median dynamic range, and that silence reads flat.
Section 14 checks ruler labels for collisions at 0.5x, 1x and 2x, and at a
narrow window where they actually collide.

Sections 15–17 sample **canvas pixels** to prove fade and zoom actually reach
the picture, rather than only checking that a lane element exists. Sample
off-centre: the synthetic test clip draws white timecode dead centre, which
pins any reading there to 255 whatever the fade is doing.

**Re-measure coordinates after anything that changes layout height.** A stale
`boundingBox()` sent clicks into the wrong lane and looked exactly like a
broken feature.

**Test a fixed point by its fixed-point property.** To check a zoom anchors
where it claims, put the focus on a known feature and assert the feature does
not move. Solving for the anchor from how a feature moves also works, but it
divides by `(1 - s)`, so a few percent of error in the estimated scale becomes
a few percent of phantom offset — that estimator reported a 4% error against
code measured elsewhere as exact.

**Prove a new guard can fail.** Restore the old behaviour, watch the check go
red, then put it back. The ruler guard passed at 1440px against the broken
rule and only had teeth once it ran at 820px.

Judge stroke weight and optical centring from a 4x element screenshot, not a
full-page one. The grey play triangle was invisible at page scale.

**Test with a realistic signal.** The synthetic clip in `verify.mjs` is a
constant full-level tone, which flattered two bugs into looking fine — the
waveform smudge survived three design passes because a constant tone happens to
render acceptably even when the scaling is wrong.

**Do not assume the ruler maps 0 to the duration.** It holds its extent after
a trim, so its right-hand end can be past the last frame — where a canvas
sample finds nothing to measure. Seek relative to the material (`[data-clip]`
boxes), not to a fraction of the ruler. One check spent a run reporting a
missing reference marker for exactly this reason.

## Not built yet

- **Transcription.** `toWav16k` is written and tested; no route consumes it. It
  is what lets the agent act on words rather than only on silence.
- **Text overlays.** The document's `text` field, `addText` and the renderer
  still work, but there is no manual way to add, edit or remove text, so the
  agent's text tools are switched off until there is. Nothing the agent can do
  should be something the user cannot do by hand.
