@AGENTS.md

# Cutline

A browser video editor where the edit is a document, an agent edits that
document, and every change is a version. Nothing uploads.

**[ARCHITECTURE.md](./ARCHITECTURE.md)** is the vocabulary and flow reference:
every domain term defined, plus diagrams for import, per-frame rendering, the
playback clock, version coalescing, the agent loop and silence-to-cut. Read it
before touching the render pipeline or the coordinate conversions.

## Architecture, in one paragraph

The edit is plain JSON (`src/lib/edl/types.ts`). Everything follows from that:
the agent's tools are pure functions over it, version control snapshots it, and
preview *interprets* it rather than rendering it. The video track is contiguous
by construction — clips play back to back in array order and no clip stores its
timeline position, so a ripple edit touches one array entry instead of
rewriting `at` on every clip after it.

Two coordinate systems run through the codebase and mixing them is the main
hazard: **source time** (seconds into an original file) and **timeline time**
(seconds into the edit). `src/lib/edl/query.ts` owns every conversion.

```
src/lib/edl/       model, pure ops, coordinate queries   ← read this first
src/lib/vcs/       commit DAG, branches, semantic diff
src/lib/media/     OPFS store, demux probe, silence detection
src/lib/agent/     tool schemas + dispatcher (shared client/server)
src/app/api/agent  streaming tool loop (claude-opus-5)
src/components/ui/ design primitives — compose these, don't restyle
```

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
- Lanes are sorted fade-under-zoom, matching how they composite.

## Rules that are load-bearing

- **Ops are pure.** Every function in `edl/ops.ts` returns a new document and
  performs no I/O. That is what lets the same code run on the client and inside
  the server's tool loop.
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

Compose `Button`, `IconButton` and `Segmented` from `components/ui`. Do not
hand-roll a control: the speed row and the branch pills were both one-off
reimplementations of `Segmented` and drifted from it within a day. Targets are
32px minimum, hover is a translucent white wash so it reads identically on
every surface, and every control answers a press with a small scale-down.

**The transport floats over the timeline card on purpose.** It straddles at
`left-2/5` from `xl` up, where it is measured clear of the toolbar, and drops
into flow below that — the toolbar grows leftward when a clip is selected and
starts swallowing clicks meant for the speed control at around 1100px. Section
23 of the e2e checks, at five widths, that nothing under the panel loses its
clicks. Verify a floating panel by measurement, not by looking at one width:
this read as "always broken" from a single narrow-window failure when it was
in fact fine at every size anyone works at.

**Confirm only what cannot be undone.** Everything in this app is undoable
except `reset()`, which clears IndexedDB and OPFS outright — so that is the one
action behind a `ConfirmDialog`. Say what is at stake (how many versions, how
many files) rather than asking "are you sure", put focus on the safe choice,
and use the filled `destructive` variant so the dangerous button is the one
that looks dangerous.

**A modal `<dialog>` needs `m-auto`.** The UA centres it with
`inset: 0; margin: auto`, and Tailwind's preflight zeroes that margin — without
it the dialog pins to the top-left corner. Section 23 of the e2e asserts the
placement, because this is invisible to every other kind of check.

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

Three authored SVGs are deliberate and are not icons: the logo mark
(`ui/Logo.tsx`), its favicon (`app/icon.svg`), and the timeline waveform, which
is geometry plotted from the actual audio.

### Waveforms

Bars are **DOM elements, not SVG rects.** The chart is stretched to each clip's
width, so an `rx` inside it is scaled unevenly per axis and renders as a
flattened ellipse; a CSS radius is in real pixels and stays round. They are
spaced at a fixed pixel pitch (`BAR_PITCH`) rather than a fixed count, so a
wide clip gets more bars instead of fatter ones — which is what keeps a full
round cap reading as softened rather than as a row of lozenges. The count comes
from a `ResizeObserver` on the track.

Envelopes are normalised **per source file** against that file's own peak, and
drawn symmetric about the clip's centre line. Scaling by absolute amplitude
draws a normally recorded voice — which peaks around 0.18, nowhere near full
scale — as a flat 20% smudge that looks like a texture rather than audio. Files
peaking below 0.02 are left unscaled so room tone is not amplified into a
waveform that is not there.

### Layout

The timeline is a card on the shell with a gutter around it, not the bottom
edge of the viewer. Its toolbar sits on a ruled band above the track so the
actions read as separate from the material they act on.

Ruler tick spacing is chosen from the **pixels available**, not from the
duration: the smallest interval in `TICK_STEPS` that leaves `MIN_TICK_PX`
between labels. Picking by duration alone meant slowing a clip stretched the
timeline without widening the ruler, so the same interval produced twice as
many labels and they overlapped by 3.4px on a narrow window.

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
bun test                    # 110 unit tests: edit algebra, effects, trim, undo, DSP, agent tools
bun test/e2e/verify.mjs     # 92 checks in real Chrome — records its own test clip
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

## Not built yet

- **Export.** Mediabunny's `Output` + `CanvasSource`, client-side. Gate it on a
  capability check: Safari below 26 cannot encode audio, Firefox Android has no
  WebCodecs. It must honour `outputSize()` and the crop transform — the preview
  already renders through exactly the maths the encoder needs.
- **Transcription.** `toWav16k` is written and tested; no route consumes it. It
  is what lets the agent act on words rather than only on silence.
