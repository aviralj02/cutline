import {
  ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget,
  CanvasSink, CanvasSource, getEncodableAudioCodecs, getEncodableVideoCodecs, Input,
  Mp4OutputFormat, Output, Quality, WebMOutputFormat,
  type InputAudioTrack,
} from "mediabunny";
import type { Edl } from "../edl/types";
import { cropOf, duration, isSlug, outputSize, placed } from "../edl/query";
import { composeFrame } from "../render/compose";
import { getMedia } from "../media/opfs";
import {
  audioPieces, exportName, frameCount, pickOutput, wantsAudio, windows,
  type AudioPiece, type OutputChoice,
} from "./plan";

/**
 * Encoding the edit to a file, in the browser. The picture goes through the
 * same `composeFrame` the preview draws with, so the export is the preview
 * written down rather than a second renderer.
 */

/** Stereo at 48kHz: what every encoder here takes without resampling surprises. */
const RATE = 48000;
const CHANNELS = 2;
/** Audio is mixed a few seconds at a time, so memory never scales with the edit. */
const WINDOW = 5;

export interface ExportProgress {
  phase: "picture" | "sound" | "finishing";
  done: number;
  total: number;
}

export interface ExportResult {
  blob: Blob;
  name: string;
  choice: OutputChoice;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

/** What this browser can write, or null if it cannot encode video at all. */
export async function exportSupport(edl: Edl, needsAudio: boolean): Promise<OutputChoice | null> {
  if (typeof window === "undefined" || !("VideoEncoder" in window)) return null;
  const { width, height } = outputSize(edl);
  const [video, audio] = await Promise.all([
    getEncodableVideoCodecs(["avc", "vp9", "vp8"], { width, height }),
    getEncodableAudioCodecs(["aac", "opus"], { numberOfChannels: CHANNELS, sampleRate: RATE }),
  ]);
  return pickOutput({ video, audio }, needsAudio);
}

interface Source {
  video: CanvasSink | null;
  audio: InputAudioTrack | null;
}

/** Each file is opened once and read from as often as the edit needs it. */
async function openSource(id: string, cache: Map<string, Source | null>): Promise<Source | null> {
  const seen = cache.get(id);
  if (seen !== undefined) return seen;
  const file = await getMedia(id);
  if (!file) {
    cache.set(id, null);
    return null;
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const video = (await input.getVideoTracks())[0] ?? null;
  const audio = (await input.getAudioTracks())[0] ?? null;
  const src: Source = {
    video: video && (await video.canDecode()) ? new CanvasSink(video) : null,
    audio: audio && (await audio.canDecode()) ? audio : null,
  };
  cache.set(id, src);
  return src;
}

/** Read one source range into the window's mix, resampled to the export rate. */
async function mixPiece(track: InputAudioTrack, piece: AudioPiece, mix: Float32Array, frames: number) {
  const dstFrom = Math.max(0, Math.round(piece.at * RATE));
  const dstTo = Math.min(frames, Math.round((piece.at + piece.dur) * RATE));
  const count = dstTo - dstFrom;
  const span = piece.to - piece.from;
  if (count <= 0 || span <= 0) return;

  const sink = new AudioSampleSink(track);
  let scratch = new Float32Array(0);
  for await (const sample of sink.samples(piece.from, piece.to)) {
    try {
      const sr = sample.sampleRate;
      const chans = sample.numberOfChannels;
      const n = sample.numberOfFrames;
      if (scratch.length < n * chans) scratch = new Float32Array(n * chans);
      for (let c = 0; c < chans; c++) {
        sample.copyTo(scratch.subarray(c * n, (c + 1) * n), { planeIndex: c, format: "f32-planar" });
      }
      // Only the destination frames this chunk actually covers, so the cost is
      // one pass over the window rather than one per chunk.
      const j0 = Math.max(0, Math.ceil(((sample.timestamp - piece.from) / span) * count));
      const j1 = Math.min(count, Math.ceil(((sample.timestamp + sample.duration - piece.from) / span) * count));
      for (let j = j0; j < j1; j++) {
        const pos = (piece.from + (span * j) / count - sample.timestamp) * sr;
        const i0 = Math.floor(pos);
        if (i0 < 0 || i0 >= n) continue;
        const frac = pos - i0;
        const i1 = Math.min(n - 1, i0 + 1);
        for (let c = 0; c < CHANNELS; c++) {
          const plane = Math.min(c, chans - 1) * n;
          mix[(dstFrom + j) * CHANNELS + c] +=
            (scratch[plane + i0] * (1 - frac) + scratch[plane + i1] * frac) * piece.gain;
        }
      }
    } finally {
      sample.close();
    }
  }
}

export interface ExportRequest {
  edl: Edl;
  /** Only used to name the saved file. */
  media: Array<{ id: string; name: string; kind?: "sound" }>;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
}

/** Render and encode the whole edit. Throws `ExportCancelled` if the signal aborts. */
export async function exportVideo({ edl, media, signal, onProgress }: ExportRequest): Promise<ExportResult> {
  const total = duration(edl);
  if (!(total > 0)) throw new Error("There is nothing on the timeline to export yet.");

  const cache = new Map<string, Source | null>();
  const clipSrcs = [...new Set(edl.clips.filter((c) => !isSlug(c)).map((c) => c.src))];
  for (const id of clipSrcs) await openSource(id, cache);
  const heard = new Set(clipSrcs.filter((id) => cache.get(id)?.audio));

  const needsAudio = wantsAudio(edl, (id) => heard.has(id));
  const choice = await exportSupport(edl, needsAudio);
  if (!choice) {
    throw new Error(
      "This browser cannot encode video. Chrome, Edge, or Safari 26 and later can — the edit itself is safe, so open Cutline there and export from your saved project.",
    );
  }

  const format =
    choice.container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });

  const { width, height } = outputSize(edl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("This browser could not open a drawing surface to render into.");

  const picture = new CanvasSource(canvas, {
    codec: choice.video,
    quality: new Quality("high"),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(picture, { frameRate: edl.fps });
  const sound = choice.audio ? new AudioSampleSource({ codec: choice.audio, quality: new Quality("high") }) : null;
  if (sound) output.addAudioTrack(sound);

  const halt = () => {
    if (signal?.aborted) throw new ExportCancelled();
  };

  try {
    halt();
    await output.start();

    const frames = frameCount(edl);
    const step = 1 / edl.fps;
    const crop = cropOf(edl);
    const view = { width, height };
    const spots = placed(edl);

    let i = 0;
    while (i < frames) {
      halt();
      const t = i * step;
      const spot = spots.find((p) => t >= p.start && t < p.end) ?? null;
      // A gap, or footage that will not decode, is black — with the fades and titles still on it.
      const src = spot && !isSlug(spot.clip) ? cache.get(spot.clip.src) ?? null : null;
      if (!spot || !src?.video) {
        composeFrame(ctx, edl, t, null, view, crop);
        await picture.add(t, step);
        i++;
        onProgress?.({ phase: "picture", done: i, total: frames });
        continue;
      }

      // Every frame of this clip in one sequential read, which is the decoder's fastest path.
      const end = Math.min(frames, Math.ceil((spot.end - 1e-6) / step));
      const rate = spot.clip.speed ?? 1;
      const times: number[] = [];
      for (let k = i; k < end; k++) times.push(spot.clip.in + (k * step - spot.start) * rate);

      let k = i;
      for await (const wrapped of src.video.canvasesAtTimestamps(times)) {
        halt();
        const at = k * step;
        composeFrame(
          ctx,
          edl,
          at,
          wrapped ? { source: wrapped.canvas, width: wrapped.canvas.width, height: wrapped.canvas.height } : null,
          view,
          crop,
        );
        await picture.add(at, step);
        k++;
        onProgress?.({ phase: "picture", done: k, total: frames });
      }
      i = Math.max(k, i + 1);
    }

    if (sound) {
      const wins = windows(total, WINDOW);
      for (let w = 0; w < wins.length; w++) {
        halt();
        const [from, to] = wins[w];
        const n = Math.max(1, Math.round((to - from) * RATE));
        const mix = new Float32Array(n * CHANNELS);
        for (const piece of audioPieces(edl, from, to)) {
          const s = await openSource(piece.src, cache);
          if (!s?.audio) continue;
          await mixPiece(s.audio, piece, mix, n);
        }
        // Two loud sources can sum past full scale; clamping beats the wrap-around that follows.
        for (let j = 0; j < mix.length; j++) mix[j] = Math.max(-1, Math.min(1, mix[j]));
        const sample = new AudioSample({
          data: mix,
          format: "f32",
          numberOfChannels: CHANNELS,
          sampleRate: RATE,
          timestamp: from,
        });
        try {
          await sound.add(sample);
        } finally {
          sample.close();
        }
        onProgress?.({ phase: "sound", done: w + 1, total: wins.length });
      }
    }

    halt();
    onProgress?.({ phase: "finishing", done: 0, total: 1 });
    await output.finalize();
    onProgress?.({ phase: "finishing", done: 1, total: 1 });

    const buffer = target.buffer;
    if (!buffer) throw new Error("The encoder finished without writing a file.");
    return {
      blob: new Blob([buffer], { type: format.mimeType }),
      name: exportName(media.find((m) => m.id === clipSrcs[0])?.name, format.fileExtension.replace(/^\./, "")),
      choice,
    };
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
}
