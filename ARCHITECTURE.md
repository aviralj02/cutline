# How Cutline works

A short guide. Read sections 1 to 4 to understand the app; the rest is
reference. Every acronym is spelled out in the [glossary](#glossary).

1. [The edit is a document](#1-the-edit-is-a-document)
2. [Two clocks](#2-two-clocks)
3. [Editing is functions over the document](#3-editing-is-functions-over-the-document)
4. [Live preview: who reads the edit](#4-live-preview-who-reads-the-edit)
5. [Where video is decoded, and WebCodecs](#5-where-video-is-decoded-and-webcodecs)
6. [Versions](#6-versions)
7. [The agent](#7-the-agent)
8. [Storage](#8-storage)
9. [Where everything lives](#9-where-everything-lives)
10. [Glossary](#glossary)
11. [Footguns](#footguns)

---

## 1. The edit is a document

Your footage is never changed. Importing a file stores it untouched in the
browser, and the edit starts as a small JSON document, the **EDL (Edit Decision
List)**, in `src/lib/edl/types.ts`:

```jsonc
{
  "fps": 30,
  "width": 1920,
  "height": 1080,
  "clips": [{ "id": "a", "src": "m1", "in": 12.4, "out": 48.9 }], // play file m1 from 12.4s to 48.9s
  "text": [
    { "id": "t1", "at": 1, "dur": 3, "content": "Intro", "style": "title" },
  ],
  "crop": { "x": 0.34, "y": 0, "w": 0.32, "h": 1 }, // fractions of the frame
  "tracks": [
    {
      "kind": "zoom",
      "items": [
        { "at": 5, "dur": 2, "scale": 1.4, "x": 0.6, "y": 0.4, "ramp": 0.4 },
      ],
    },
    {
      "kind": "fade",
      "items": [{ "at": 38, "dur": 1, "mode": "out", "color": "#000000" }],
    },
  ],
}
```

Everything follows from this:

- **Preview** reads the document and draws it, live (section 4).
- **Versions** are snapshots of the document (section 6).
- **The agent** edits the document with the same functions you do (section 7).
- **Export** reads the same document and encodes a file (section 5).

## 2. Two clocks

Mixing these two up is the most common bug.

- **Source time:** seconds into an original file. A clip's `in` and `out`.
- **Timeline time:** seconds into the finished edit. A zoom's or a title's `at`.

```
SOURCE    interview.mp4  0 ──────────────────────────── 60s
                              ├─ kept ─┤      ├─ kept ─┤
                             12        28     40       52

TIMELINE  the edit       0 ────────────── 28s
                         ├ clip 1 ┤├ clip 2 ┤
                         0        16        28
```

Clips play back to back in array order. Empty space is an entry too: a gap is a
**slug**, a clip of blank leader, so the track never has a hole. A clip's
timeline position isn't stored; it's the sum of the entries before it, so
deleting one touches one entry. `src/lib/edl/query.ts` owns every conversion between the
clocks (`placed`, `resolve`, `sourceToTimeline`, `sourceRangeToTimeline`).

## 3. Editing is functions over the document

Every edit is a pure function in `src/lib/edl/ops.ts`: it takes a document and
returns a new one, with no I/O (input/output). Each ends in `normalize()`, which
snaps every time to a frame boundary, so identical edits produce identical JSON.

| You do                    | Function                     | What changes in the document                                                   |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Split at the playhead     | `splitAt`                    | One clip becomes two windows onto the same file                                |
| Delete a clip or a span   | `deleteClip`, `rippleDelete` | Clip windows shrink; everything after slides left                              |
| Drag a clip's edge        | `trimClipEdge`               | That clip's `in` or `out`; a slug takes the freed space, so nothing else moves |
| Close a gap               | `deleteClip` on the slug     | The slug goes; everything after slides left                                    |
| Add a sound               | `addSound`                   | An item on the sound lane: its file, where it starts, how far into the file    |
| Mute the original audio   | `setVideoMuted`              | `videoMuted`; sound lanes still play                                           |
| Drag a clip to a new slot | `moveClip`                   | Its position in the `clips` array                                              |
| Change speed              | `setSpeed`                   | `speed`; a 2× clip takes half the timeline                                     |
| Crop to 9:16              | `setCropAspect`              | `crop`                                                                         |
| Add a fade or zoom        | `addEffect`                  | An interval on that kind's lane in `tracks`                                    |

## 4. Live preview: who reads the edit

There is no render step. A loop in `src/components/Preview.tsx` re-reads the
document on every screen refresh, about 60 times a second, and draws that one
moment:

```
you edit (split, drag a zoom, the agent)
   │
   ▼
store: a new version, or a draft while you're still dragging      src/lib/store.ts
   │   useEdl() returns the draft if there is one, else the current version
   ▼
Preview copies it into a ref: edlRef.current = edl
   │
   ▼
the requestAnimationFrame loop, every frame:
   │   cur = edlRef.current     the latest document
   │   t   = the playhead
   ▼
query functions answer "what is on screen at t?"                 src/lib/edl/query.ts
   placed(cur)     which clip, and how far into its file
   cropOf(cur)     the framing transform
   zoomAt(cur, t)  scale and focal point right now, or none
   fadeAt(cur, t)  wash colour and opacity right now, or none
   │
   ▼
canvas, in a fixed order:
   1. crop transform   2. zoom about its focal point   3. drawImage(the <video>)
   4. titles, above the zoom so they don't scale   5. the fade wash over everything
```

- **Edits show within one frame.** The loop is started once and reads the
  document through a ref, so a change is simply picked up by the next frame.
- **Drags are live through the draft.** Each pointer move writes a temporary
  draft; letting go commits one version.
- **The video element is the clock.** While a clip plays, its `<video>`
  element's time drives the playhead, keeping sound and picture together. At a
  clip's `out` point the next clip's file is seeked to its `in`. **A cut is a
  seek.**
- **A gap plays as black.** It has no video to keep time, so the frame loop's
  own clock carries the playhead across it; titles and fades still draw.
- **Sound follows the playhead.** Each sound item has its own `<audio>`
  element. The frame loop plays it while the playhead is inside it, stops it
  outside, and re-seeks it only when it drifts more than 0.25s. The video's own
  sound follows `videoMuted`.
- **Effects are arithmetic, not stored frames.** `zoomAt` eases the scale over
  `ramp` seconds with smoothstep; `fadeAt` turns "how far through the fade" into
  an opacity.
- **Export draws with this same function.** Steps 1 to 5 above live in
  `composeFrame` (`src/lib/render/compose.ts`), which the preview calls every
  frame and the encoder calls for every frame of the file — so the export is
  the preview written down, not a second renderer to keep in step.

Other parts of the screen read the same document:

| Reader          | Uses it for                                            |
| --------------- | ------------------------------------------------------ |
| `Timeline.tsx`  | Clip blocks, effect lanes, the ruler                   |
| `Transport.tsx` | Duration and timecode                                  |
| `History.tsx`   | "−1 clip, −4.0s" between versions                      |
| The agent       | A text description of it (`describeState`), then tools |

## 5. Where video is decoded, and WebCodecs

A **container** (MP4, WebM) holds **streams** compressed with a **codec**
(H.264, VP9, AAC, Opus). **Demuxing** reads a container's streams and metadata
without decompressing; **decoding** decompresses them into raw frames or audio
samples. Cutline decodes in three places, for three jobs:

| Job         | Decoder                                           | Why                                                            |
| ----------- | ------------------------------------------------- | -------------------------------------------------------------- |
| **Preview** | The browser's `<video>` element                   | Hardware accelerated; Cutline only draws it onto the canvas    |
| **Import**  | **WebCodecs**, through the **Mediabunny** library | Needs real audio samples to find silence and draw the waveform |
| **Export**  | WebCodecs encoders, through Mediabunny            | Turns the drawn canvas back into a compressed file             |

**Import** (`src/lib/media/analyze.ts`):

```
drop a file → is there room? (storage quota)
   ├─ store it in OPFS, untouched
   ├─ demux (probeVideo): real fps and display width/height, rotation-corrected
   └─ decode the audio a chunk at a time (summariseAudio):
         each chunk → one loudness value per 10ms, and peaks for the waveform
         → an hour of audio becomes about 4MB of numbers, not 1.4GB of samples
         → silence = stretches quieter than a threshold set from the file's own range
```

Silences are stored raw, in source time, so the agent can choose its own
minimum length and padding without re-reading the audio. Codecs WebCodecs won't
decode fall back to the Web Audio decoder, which reads the whole track at once.

**Export** (`src/lib/export/`) runs the preview's own renderer once per output
frame:

```
for each frame of the edit:
   the clip's file → Mediabunny CanvasSink → the frame at that source time
   composeFrame(...) draws it at outputSize(), with crop, zoom, titles, fade
   → CanvasSource: the WebCodecs video encoder
then, five seconds at a time:
   audioPieces(edl, from, to) says which file, which range, at what volume
   → read, resample to 48kHz stereo, mix, clamp → the audio encoder
→ Mediabunny writes the MP4 (or WebM), and you save it
```

The container comes from what this browser can actually encode: MP4 with
H.264 when it is available because it plays everywhere, WebM otherwise, and
the sound is kept in preference to the container. Safari below 26 can't encode
audio and Firefox on Android has no WebCodecs at all, so the dialog says what
it is able to write before it starts. Memory stays flat because audio is mixed
a window at a time, the same reason import streams its analysis.

`plan.ts` holds the half that is decided by the document alone — how many
frames, which source range feeds each moment of sound, which container — with
no browser APIs in it, so all of that is tested without an encoder.

**Limits of this approach.** Seeking is only as exact as the browser's (the
preview re-seeks when it's more than 50ms off), a cut can stutter on large files
because it's a real seek, and there is one video track. Frame-exact preview
would mean decoding video with WebCodecs' `VideoDecoder` directly.

## 6. Versions

`src/lib/vcs/repo.ts`. Each version is a full copy of the document with a
parent, a message and an author (you or the agent). Documents are a few dozen
KB, so full copies cost nothing and restoring is instant.

- **Undo** steps back and deletes the version, unless another variant still
  needs it. Redo is kept in memory until the next edit.
- **Restore** brings an old version back as a new version.
- **A variant** is a branch: a named line of versions you can switch between.
  Deleting one removes the versions only it had, after a confirmation.
- **One gesture, one version.** Drags and sliders edit a draft and commit on
  release; an edit identical to the current version is never saved.

## 7. The agent

Cutline ships no AI access. You paste an API (application programming
interface) key from Anthropic, OpenAI, Google Gemini, OpenRouter, Groq,
Mistral, xAI or DeepSeek. That's BYOK (bring your own key), and there is no
custom endpoint.

```
your request
   → seedFor: your last few requests, a text description of the edit, the request
   → the model, via the provider's wire:
        Anthropic → its official SDK (software development kit), in the browser
        the other seven → OpenAI-style chat completions over fetch
   → the model asks for tools, e.g. ripple_delete 0–5s
   → applyTool runs each one on the document, and each step shows as it happens
   → results go back; repeat until the model answers without a tool
   → one version, named after your request. Stop discards the whole attempt.
```

- **No server in between.** The loop (`src/lib/ai/agent.ts`) runs in the page,
  so the key goes from the browser to its provider and nowhere else. Every
  listed provider allows this (it answers the browser's CORS preflight).
- **Recognising a key.** `detect()` reads its prefix (`sk-ant-` is Anthropic).
  A key that could belong to two providers becomes a choice; Cutline never
  tries a key on providers to find out.
- **Connecting** lists the key's models: that proves the key and picks the
  starting model (`claude-opus-5` on Anthropic).
- **Anthropic requests** send adaptive thinking and effort only to models that
  support them, and turn on refusal fallbacks for the top models.
- **Loose requests work.** Every manual action has a tool. The description of
  the edit includes the playhead, the selection and the last change, so
  "split here", "delete this" and "undo" each mean something, and clips carry
  the numbers shown on screen.

## 8. Storage

Everything stays on the device.

| What                                   | Where                           | Why there                                                                            |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| Footage                                | OPFS                            | Real files, written as a stream; up to 4 GB each, within the browser's storage quota |
| Project: versions, analysis, waveforms | IndexedDB                       | A structured database that survives reloads                                          |
| API key and model                      | localStorage, or sessionStorage | Remembered on this device, or gone when the tab closes; never with the project       |

New project clears OPFS and IndexedDB, after a confirmation. It leaves the key.

## 9. Where everything lives

```
src/lib/edl/          the document: types, pure edit functions, the two clocks   ← start here
src/lib/vcs/          versions, variants, undo, the semantic diff
src/lib/media/        OPFS storage, demuxing, audio analysis, silence
src/lib/render/       composeFrame: one frame of the edit, for preview and export
src/lib/export/       the document half of an export, and the encoder itself
src/lib/agent/        the agent's tools: pure functions over the document
src/lib/ai/           bring your own key: providers, the loop, the two wires, key storage
src/lib/store.ts      app state, drafts, running the agent
src/components/       Preview, Timeline, Transport, Chat, History
src/components/ai/    the key card and the model-and-key modal
src/components/ui/    design primitives: compose these, don't restyle
```

## Glossary

**Acronyms**

| Term | Stands for                        | Here                                                      |
| ---- | --------------------------------- | --------------------------------------------------------- |
| EDL  | Edit Decision List                | The JSON document that is the edit                        |
| OPFS | Origin Private File System        | Browser-private disk where footage is stored              |
| API  | Application Programming Interface | How the app talks to a model provider                     |
| BYOK | Bring Your Own Key                | Users supply their own provider key                       |
| SDK  | Software Development Kit          | Anthropic's official client library                       |
| CORS | Cross-Origin Resource Sharing     | The browser rule a provider must allow for direct calls   |
| I/O  | Input/Output                      | What edit functions never do                              |
| fps  | Frames per second                 | Read from the file, never assumed                         |
| VFR  | Variable Frame Rate               | Screen recordings; an average rate is used                |
| PCM  | Pulse-Code Modulation             | Raw, uncompressed audio samples                           |
| RMS  | Root Mean Square                  | Loudness over a short window                              |
| dBFS | Decibels relative to Full Scale   | Loudness scale; 0 is the loudest possible                 |
| DAG  | Directed Acyclic Graph            | The shape of a version history with variants              |
| rAF  | requestAnimationFrame             | The browser's once-per-frame callback the preview runs on |

**Editing**

- **Clip:** one window onto one file, a `src` with an `in` and `out`.
- **Split:** one clip becomes two, with nothing removed.
- **Ripple delete:** remove a span and close the space it leaves.
- **Trim:** move one edge of a clip or effect. Nothing else moves; a slug fills
  any space the trim frees.
- **Slug:** blank leader. How a gap is stored on the track: a clip with no file.
- **Snapping:** a drag catches on the edit's landmarks — every cut, both ends,
  the playhead, and the other lanes' edges — from 7 pixels away, with a dashed
  guide while it holds. It is how a fade lands exactly on the cut it belongs
  to (`src/lib/edl/snap.ts`).
- **Sound lane:** music or other audio files under the picture. Each item is a
  window onto its file: where it starts on the timeline (`at`), how long it
  plays (`dur`) and from how far into the file (`in`).
- **Original audio:** the sound recorded with the video. It can be muted for
  the whole edit without touching the sound lane.
- **Playhead:** the current position. **Scrub:** drag it, on the ruler only.
- **Lane:** a row for one kind of effect, below the video.
- **Fade:** a wash to or from a colour. In, out, or a **dip** through it and back.
- **Zoom (punch-in):** scale the picture about a **focal point**, the one spot
  that doesn't move.
- **Ramp:** seconds spent easing in and out, with **smoothstep** (t²(3−2t)).
- **Frame snapping:** rounding a time to the nearest frame.
- **Span vs duration:** the ruler can hold its width after a trim; Fit resets it.

**Media**

- **Container / codec:** the file wrapper (MP4) vs the compression inside (H.264).
- **Demux / mux:** unpack streams from a container / pack them into one.
- **Keyframe:** a frame stored whole; seeking lands on these.
- **WebCodecs:** the browser API for encoding and decoding audio and video.
- **Mediabunny:** the library Cutline uses for demuxing and WebCodecs.
- **Coded vs display size:** phones store sideways pixels plus a rotation flag;
  always use the display size.

**Interface**

- **Mat:** the mid-grey around the picture; black would make footage look brighter.
- **Gate:** the rounded frame the picture sits in.
- **Leader:** amber, for the agent and the main action. **Grease:** red, for
  cuts and deletion only.
- **Draft:** an unsaved edit shown live during a drag.
- **Transport:** the play controls.
