import { expect, test, describe } from "bun:test";
import { detectSilences, waveform, toWav16k, type AudioAnalysis } from "../src/lib/media/analyze";

const SR = 16000;

/** Build a mono track: loud "speech" everywhere except the given quiet gaps. */
function synth(duration: number, gaps: Array<[number, number]>, noiseFloor = 0.0008): AudioAnalysis {
  const n = duration * SR;
  const samples = new Float32Array(n);
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const quiet = gaps.some(([a, b]) => t >= a && t < b);
    // Speech: a voiced tone plus breath noise. Silence: room tone only.
    samples[i] = quiet ? rand() * noiseFloor : Math.sin(t * 2 * Math.PI * 180) * 0.35 + rand() * 0.05;
  }
  return { samples, sampleRate: SR, duration };
}

const near = (a: number, b: number, tol = 0.15) => Math.abs(a - b) <= tol;

describe("detectSilences", () => {
  test("finds known gaps and ignores speech", () => {
    const a = synth(30, [[5, 7], [12, 13.5], [22, 25]]);
    const { ranges } = detectSilences(a, { padding: 0 });
    expect(ranges.length).toBe(3);
    expect(near(ranges[0][0], 5) && near(ranges[0][1], 7)).toBe(true);
    expect(near(ranges[1][0], 12) && near(ranges[1][1], 13.5)).toBe(true);
    expect(near(ranges[2][0], 22) && near(ranges[2][1], 25)).toBe(true);
  });

  test("ignores pauses shorter than minSilence", () => {
    const a = synth(20, [[5, 5.15], [10, 12]]); // 150ms is speech rhythm, not dead air
    const { ranges } = detectSilences(a, { minSilence: 0.35, padding: 0 });
    expect(ranges.length).toBe(1);
    expect(near(ranges[0][0], 10)).toBe(true);
  });

  test("padding keeps a margin inside each cut", () => {
    const a = synth(20, [[5, 9]]);
    const bare = detectSilences(a, { padding: 0 }).ranges[0];
    const pad = detectSilences(a, { padding: 0.2 }).ranges[0];
    expect(pad[0]).toBeGreaterThan(bare[0]);
    expect(pad[1]).toBeLessThan(bare[1]);
    expect(near(pad[0] - bare[0], 0.2, 0.02)).toBe(true);
  });

  test("continuous speech yields no cuts", () => {
    expect(detectSilences(synth(15, [])).ranges.length).toBe(0);
  });

  test("adapts to a quiet recording", () => {
    // Everything 20dB down: a fixed -40dBFS threshold would delete the whole file.
    const a = synth(20, [[6, 9]]);
    for (let i = 0; i < a.samples.length; i++) a.samples[i] *= 0.1;
    const { ranges, removedSeconds } = detectSilences(a, { padding: 0 });
    expect(ranges.length).toBe(1);
    expect(removedSeconds).toBeLessThan(4);
  });

  test("leading and trailing dead air is removable", () => {
    const a = synth(20, [[0, 3], [17, 20]]);
    const { ranges } = detectSilences(a, { padding: 0 });
    expect(ranges.length).toBe(2);
    expect(near(ranges[0][0], 0)).toBe(true);
    expect(near(ranges[1][1], 20, 0.2)).toBe(true);
  });

  test("reports total removable time", () => {
    const { removedSeconds } = detectSilences(synth(30, [[5, 7], [20, 23]]), { padding: 0 });
    expect(near(removedSeconds, 5, 0.3)).toBe(true);
  });

  test("handles an empty track without throwing", () => {
    const empty: AudioAnalysis = { samples: new Float32Array(0), sampleRate: SR, duration: 0 };
    expect(detectSilences(empty).ranges).toEqual([]);
  });
});

describe("waveform + wav", () => {
  test("waveform tracks loudness", () => {
    const w = waveform(synth(20, [[10, 15]]), 200);
    expect(w.length).toBe(200);
    expect(w[20]).toBeGreaterThan(0.2); // speech
    expect(w[125]).toBeLessThan(0.02); // gap
  });

  test("wav is 16k mono PCM16 with a valid header", () => {
    const a = synth(2, []);
    const blob = toWav16k(a);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + 2 * 16000 * 2); // 2s @ 16k, 2 bytes/sample
  });

  test("wav is far smaller than the source audio", () => {
    const a = synth(60, []); // 60s @ 16k float32 = 3.8MB in memory
    expect(toWav16k(a).size).toBeLessThan(2_000_000); // ~1MB/min on the wire
  });
});
