# Cutline

A browser video editor where the edit is a **document**, an agent edits that document,
and every change is a **version** you can restore.

No uploads. Your footage never leaves your machine.

New to video editing? **[ARCHITECTURE.md](./ARCHITECTURE.md)** defines every
term this codebase uses — EDL, ripple delete, dBFS, demuxing, swatches — and
diagrams the import, render, playback, versioning and agent flows.

## The idea

The whole design rests on one decision: the edit is plain JSON, not video.

```jsonc
{
  "version": 1, "fps": 30, "width": 1920, "height": 1080,
  "clips": [ { "id": "a1", "src": "m1", "in": 12.4, "out": 48.9 } ],
  "text":  [ { "id": "t1", "at": 1.0, "dur": 3.0, "content": "…", "style": "lower-third" } ]
}
```

Because the edit is a document:

- **The agent edits JSON, never pixels.** Its tools are pure functions over this object.
- **Version control is trivial.** The document is ~30KB, so every version is a full
  snapshot — O(1) restore, no replay, no merge algorithm, no corrupt history.
- **Preview is interpretation, not rendering.** A canvas compositor seeks `<video>`
  elements according to the document. Nothing renders until you export.

The video track is **contiguous by construction** — clips play back to back in array
order and no clip stores its timeline position. A ripple edit touches one array entry
instead of rewriting a position on every clip after it, which keeps version diffs
readable.

## Running it

```bash
bun install
bun dev
```

No environment file. To use the agent, paste an API key into the Ask panel.

Drop in an MP4 or WebM. Import runs locally: a Mediabunny demux to read the file's
real parameters, an OPFS write, an audio decode, and silence detection.

Frame rate and display dimensions come from demuxing the container, not from a
`<video>` element — a video element reports *coded* dimensions, so rotated phone
footage would otherwise import sideways, and it cannot report frame rate at all.

## What the agent knows

An agent that can't see your footage can only do mechanical operations. On import,
Cutline analyses the audio and hands the model a description of the content:

- **Silence detection** — RMS loudness in 25ms windows, with the threshold derived
  from the file's own dynamic range rather than a fixed dBFS value, so a quiet phone
  recording and a loud studio mic both work untuned.
- Detections are stored **raw and unpadded**, so the model can retune `min_silence`
  and `padding` per request without re-analysing the audio.

That's what makes "cut all the silences" a real request rather than a guess.

## Bring your own key

Cutline ships no model access of its own. Paste a key from **Anthropic,
OpenAI, Google Gemini, OpenRouter, Groq, Mistral, xAI or DeepSeek**. The
provider is read from the key itself.

- **Your key goes from your browser to your provider, and nowhere else.** The
  agent loop runs in the page; there is no Cutline server in between. Every
  listed provider accepts requests straight from a browser.
- **It stays in this browser.** Remembered on this device by default, or kept
  only until the tab closes. Never saved with a project.
- **Pick any model the key can use.** Cutline starts on the best one for
  editing — Claude Opus 5 on an Anthropic key — and lists the rest.

## Layout

```
src/lib/edl/       types, pure operations, coordinate queries   ← the core
src/lib/vcs/       commit DAG, branches, semantic diff
src/lib/media/     OPFS store, audio analysis, silence detection
src/lib/agent/     tool schemas + dispatcher: pure functions over the edit
src/lib/ai/        bring-your-own-key: providers, the agent loop, two wires
src/components/    preview + playback, timeline, chat, history
```

Two coordinate systems run through everything, and mixing them up is the main hazard:
**source time** (seconds into an original file) and **timeline time** (seconds into
the edit). `query.ts` owns the conversions.

## Tests

```bash
bun test                    # 159 unit tests: edit algebra, silence DSP, agent tools, BYOK
bun test/e2e/verify.mjs     # 201 checks in real Chrome — records its own test video
```

The e2e script generates a 20-second clip with two deliberate silent stretches using
canvas + MediaRecorder, imports it, and checks that analysis, versioning, restore,
playback and reload persistence all hold.

## Not built yet

- **Export.** The plan is Mediabunny's `Output` + `CanvasSource`, fully client-side
  (`mp4-muxer` is deprecated in favour of Mediabunny by the same author). Gate it
  behind a capability check — Safari below 26 can decode but not encode audio, and
  Firefox Android has no WebCodecs at all.
- **Transcription.** The audio-to-16kHz-WAV path is written and tested
  (`toWav16k`, ~1MB/min) but no `/api/transcribe` route exists. Once it does, the
  agent can act on *words* — "cut the part about pricing" — instead of only on
  silence.
- Multiple video tracks, b-roll compositing, transitions, audio mixing, colour.
