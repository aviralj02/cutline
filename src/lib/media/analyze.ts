import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";

/**
 * Content analysis. This is what turns the agent from a JSON manipulator into
 * something that can act on the footage: without a description of what is
 * actually in the media, "cut the dead air" is not a request it can answer.
 *
 * Everything here runs in the browser, on the user's machine, with no key and
 * no upload.
 */

export interface AudioAnalysis {
  /** Mono, source sample rate. */
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

/** Decode a video/audio file's audio track to mono PCM. */
export async function decodeAudio(file: File): Promise<AudioAnalysis> {
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = buf.length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += data[i];
    }
    if (buf.numberOfChannels > 1) {
      for (let i = 0; i < n; i++) mono[i] /= buf.numberOfChannels;
    }
    return { samples: mono, sampleRate: buf.sampleRate, duration: buf.duration };
  } finally {
    void ctx.close();
  }
}

/** Frame-wise loudness in dBFS. */
function loudnessCurve(a: AudioAnalysis, hopMs = 10, winMs = 25) {
  const hop = Math.max(1, Math.round((hopMs / 1000) * a.sampleRate));
  const win = Math.max(hop, Math.round((winMs / 1000) * a.sampleRate));
  const frames = Math.max(0, Math.floor((a.samples.length - win) / hop) + 1);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const s = f * hop;
    for (let i = s; i < s + win; i++) sum += a.samples[i] * a.samples[i];
    db[f] = 20 * Math.log10(Math.sqrt(sum / win) + 1e-9);
  }
  return { db, hopSec: hop / a.sampleRate };
}

const percentile = (sorted: Float32Array, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

export interface SilenceOptions {
  /** Ignore pauses shorter than this. Natural speech rhythm lives below ~0.35s. */
  minSilence?: number;
  /** Leave this much silence on each side of a cut so consonants survive. */
  padding?: number;
  /** Override the auto threshold, in dBFS. */
  thresholdDb?: number;
}

export interface SilenceResult {
  /** Ranges in source-file seconds, disjoint and ascending. */
  ranges: Array<[number, number]>;
  thresholdDb: number;
  removedSeconds: number;
}

/**
 * Find removable dead air. The threshold is derived from the file's own
 * dynamic range rather than a fixed dBFS number, so a quiet phone recording
 * and a loud studio mic both work without the user tuning anything.
 */
export function detectSilences(a: AudioAnalysis, opts: SilenceOptions = {}): SilenceResult {
  const { db, hopSec } = loudnessCurve(a);
  return silencesFromLoudness(db, hopSec, opts);
}

/**
 * The detector proper, working from a loudness curve rather than from samples.
 * Streaming analysis produces the curve without ever holding the audio, so the
 * two paths must agree on everything downstream of it — which they do by being
 * literally the same code.
 */
export function silencesFromLoudness(
  db: Float32Array,
  hopSec: number,
  opts: SilenceOptions = {},
  /** Seconds into the file that `db[0]` describes. */
  offset = 0,
): SilenceResult {
  const { minSilence = 0.35, padding = 0.08 } = opts;
  if (!db.length) return { ranges: [], thresholdDb: -60, removedSeconds: 0 };

  const sorted = Float32Array.from(db).sort();
  const floor = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.95);
  const auto = floor + (peak - floor) * 0.25;
  const thresholdDb = opts.thresholdDb ?? Math.min(-22, Math.max(-62, auto));

  const ranges: Array<[number, number]> = [];
  let runStart = -1;
  for (let f = 0; f <= db.length; f++) {
    const quiet = f < db.length && db[f] < thresholdDb;
    if (quiet && runStart < 0) runStart = f;
    if (!quiet && runStart >= 0) {
      const from = offset + runStart * hopSec;
      const to = offset + f * hopSec;
      if (to - from >= minSilence) {
        // Pad inward. A cut that lands exactly on the waveform clips speech.
        const lo = from + padding;
        const hi = to - padding;
        if (hi - lo > 0.05) ranges.push([lo, hi]);
      }
      runStart = -1;
    }
  }

  return {
    ranges,
    thresholdDb,
    removedSeconds: ranges.reduce((s, [x, y]) => s + (y - x), 0),
  };
}

/** Downsampled peak envelope for drawing the timeline. */
export function waveform(a: AudioAnalysis, buckets = 2000): Float32Array {
  const out = new Float32Array(buckets);
  const per = a.samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(a.samples.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = s; i < e; i += 4) {
      const v = Math.abs(a.samples[i]);
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}

/**
 * 16kHz mono PCM16 WAV. A minute of video is ~1MB here versus hundreds for
 * the source, which is why transcription can go to a server while the video
 * itself never leaves the machine.
 */
export function toWav16k(a: AudioAnalysis): Blob {
  const target = 16000;
  const ratio = a.sampleRate / target;
  const n = Math.floor(a.samples.length / ratio);
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, a.samples[Math.floor(i * ratio)]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

/**
 * Read a file's real parameters by demuxing it, not by loading it into a
 * <video> element. That matters for two reasons: `videoWidth` reports coded
 * dimensions, so rotated phone footage imports sideways, and a video element
 * cannot tell us the frame rate at all — which the whole timeline snaps to.
 */
export async function probeVideo(file: File): Promise<Probe> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const [track] = await input.getVideoTracks();
    if (!track) throw new Error("No video track in this file.");

    const duration = await input.computeDuration();
    // Sampling packets is far cheaper than decoding and gives a real rate,
    // including for variable-frame-rate screen recordings.
    const stats = await track.computePacketStats(120);
    const rate = stats.averagePacketRate;
    const fps = Number.isFinite(rate) && rate > 0 ? Math.round(rate) : 30;

    return {
      // displayWidth/Height already account for rotation and pixel aspect.
      width: track.displayWidth,
      height: track.displayHeight,
      duration,
      fps: Math.min(120, Math.max(1, fps)),
      hasAudio: (await input.getAudioTracks()).length > 0,
    };
  } catch (err) {
    throw new Error(
      err instanceof Error && /No video track/.test(err.message)
        ? err.message
        : "Could not read this file. Try an MP4 (H.264) or WebM.",
    );
  }
}

/* ---------------------------------------------------------------------------
   Streaming analysis

   `decodeAudio` above holds the whole track in memory: `file.arrayBuffer()`
   materialises the container, and `decodeAudioData` then expands it to
   Float32 at the source rate. An hour of 48kHz stereo is 1.4GB of decoded
   audio before the mono downmix, on top of the file itself — which is the
   real reason a long recording used to fail on import with nothing but a
   browser out-of-memory in the console.

   Nothing downstream needs the samples. Silence detection needs a loudness
   curve and the timeline needs a peak envelope, and both are thousands of
   numbers, not billions. So this path decodes through Mediabunny's audio sink
   and folds each chunk into those two arrays as it arrives, holding one chunk
   at a time. Memory is then a function of duration alone — about 4MB an hour —
   and the ceiling on an import becomes disk, not RAM.
   --------------------------------------------------------------------------- */

/** Hop for the streamed loudness curve, matching `loudnessCurve`. */
const HOP_MS = 10;
/** Hops per RMS window: 3 × 10ms ≈ the 25ms window of the buffered path. */
const WINDOW_HOPS = 3;

export interface AudioSummary {
  /** Frame-wise loudness in dBFS, one entry per `hopSec`. */
  db: Float32Array;
  hopSec: number;
  /** Seconds into the file that `db[0]` describes. */
  startSec: number;
  /** Peak envelope for drawing, one entry per bucket across the whole file. */
  wave: Float32Array;
  duration: number;
}

export interface SummaryOptions {
  buckets?: number;
  /** Called with 0–1 as the track is read. A long file is otherwise silent. */
  onProgress?: (fraction: number) => void;
}

/**
 * Decode a file's audio track in chunks, keeping only the loudness curve and
 * the peak envelope. Returns null when the file has no audio track, and
 * throws only if decoding itself fails — callers fall back to `decodeAudio`.
 */
export async function summariseAudio(
  file: File,
  { buckets = 1600, onProgress }: SummaryOptions = {},
): Promise<AudioSummary | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const [track] = await input.getAudioTracks();
  if (!track) return null;
  if (!(await track.canDecode())) throw new Error("This browser cannot decode that audio codec.");

  const duration = (await track.computeDuration()) || (await input.computeDuration());
  // Without a duration there is no grid to fold samples into: the bucket width
  // would be zero and every sample would land in the last one.
  if (!(duration > 0)) return null;
  const hops = Math.max(1, Math.ceil(duration / (HOP_MS / 1000)) + WINDOW_HOPS);

  // Running sums per hop, resolved to dBFS once the whole track is in.
  const sumSq = new Float64Array(hops);
  const counts = new Float64Array(hops);
  const wave = new Float32Array(buckets);

  let sampleRate = 0;
  let frames = 0;
  /** The first and last hops that actually received audio. */
  let firstHop = -1;
  let lastHop = 0;
  let mono = new Float32Array(0);
  let plane = new Float32Array(0);
  let nextTick = 0;

  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples()) {
    try {
      sampleRate ||= sample.sampleRate;
      const n = sample.numberOfFrames;
      const chans = sample.numberOfChannels;
      if (mono.length < n) {
        mono = new Float32Array(n);
        plane = new Float32Array(n);
      }
      mono.fill(0, 0, n);
      for (let c = 0; c < chans; c++) {
        sample.copyTo(plane.subarray(0, n), { planeIndex: c, format: "f32-planar" });
        for (let i = 0; i < n; i++) mono[i] += plane[i];
      }
      if (chans > 1) for (let i = 0; i < n; i++) mono[i] /= chans;

      // The sample's own timestamp places it, so a gap in the track does not
      // shift everything after it — which counting frames alone would do.
      const base = Math.round(sample.timestamp * sampleRate);
      const perHop = (HOP_MS / 1000) * sampleRate;
      const perBucket = (duration * sampleRate) / buckets;
      for (let i = 0; i < n; i++) {
        const at = base + i;
        const v = mono[i];
        // Codec priming can put the first sample slightly before zero.
        const h = Math.max(0, Math.min(hops - 1, Math.floor(at / perHop)));
        sumSq[h] += v * v;
        counts[h] += 1;
        if (h > lastHop) lastHop = h;
        if (firstHop < 0 || h < firstHop) firstHop = h;
        const b = Math.max(0, Math.min(buckets - 1, Math.floor(at / perBucket)));
        const a = v < 0 ? -v : v;
        if (a > wave[b]) wave[b] = a;
      }
      frames += n;
      if (onProgress && sample.timestamp >= nextTick) {
        nextTick = sample.timestamp + Math.max(1, duration / 50);
        onProgress(Math.min(1, duration ? sample.timestamp / duration : 0));
      }
    } finally {
      sample.close();
    }
  }
  onProgress?.(1);
  if (!frames) return null;

  // Windowed RMS over WINDOW_HOPS, so the curve has the same smoothing as the
  // buffered path rather than the jitter of a bare 10ms frame.
  //
  // The curve covers only the hops that received audio. An audio track rarely
  // spans exactly the same range as the video — a MediaRecorder capture starts
  // its audio about half a second in — and hops outside it hold no samples, so
  // they read -180 dBFS and the detector calls the gap a pause. That is how a
  // clip with two planted silences came back with three.
  const start = Math.max(0, firstHop);
  const db = new Float32Array(Math.max(1, lastHop - start + 1));
  for (let f = 0; f < db.length; f++) {
    let s = 0;
    let c = 0;
    for (let k = 0; k < WINDOW_HOPS && start + f + k <= lastHop; k++) {
      s += sumSq[start + f + k];
      c += counts[start + f + k];
    }
    db[f] = 20 * Math.log10(Math.sqrt(c ? s / c : 0) + 1e-9);
  }

  // Times stay in container seconds — the same clock the video element seeks
  // by, and the one every clip's in/out point is written in.
  return { db, hopSec: HOP_MS / 1000, startSec: start * (HOP_MS / 1000), wave, duration };
}
