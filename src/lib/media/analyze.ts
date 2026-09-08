import { ALL_FORMATS, BlobSource, Input } from "mediabunny";

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
  const { minSilence = 0.35, padding = 0.08 } = opts;
  const { db, hopSec } = loudnessCurve(a);
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
      const from = runStart * hopSec;
      const to = f * hopSec;
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
