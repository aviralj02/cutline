import { describe, expect, test } from "bun:test";
import { emptyEdl } from "../src/lib/edl/types";
import { addSound, insertClip, setSpeed, setVideoMuted, splitAt, trimClipEdge, updateEffect } from "../src/lib/edl/ops";
import { soundsOf } from "../src/lib/edl/query";
import { audioPieces, exportName, frameCount, pickOutput, wantsAudio, windows } from "../src/lib/export/plan";

const base = () => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 20 }); // a 20s edit at 30fps
const heard = () => true;

describe("what the exporter has to draw", () => {
  test("a frame per frame of the edit", () => {
    expect(frameCount(base())).toBe(600);
    expect(frameCount(emptyEdl(30))).toBe(1);
  });

  test("a sped-up clip makes a shorter file", () => {
    const e = base();
    expect(frameCount(setSpeed(e, e.clips[0].id, 2))).toBe(300);
  });
});

describe("where each moment of sound comes from", () => {
  test("a plain clip plays its own audio, straight through", () => {
    const [p, ...rest] = audioPieces(base(), 0, 5);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ src: "m1", from: 0, to: 5, at: 0, dur: 5, gain: 1 });
  });

  test("a window in the middle reads the middle of the file", () => {
    const [p] = audioPieces(base(), 5, 10);
    expect(p).toMatchObject({ from: 5, to: 10, at: 0, dur: 5 });
  });

  test("a trimmed clip reads from its in-point, and the room it left is silent", () => {
    const start = base();
    const e = trimClipEdge(start, start.clips[0].id, "start", 4);
    expect(audioPieces(e, 4, 6)[0]).toMatchObject({ src: "m1", from: 4, to: 6, at: 0, dur: 2 });
    expect(audioPieces(e, 0, 2)).toEqual([]);
  });

  test("a 2x clip reads twice as much file for the same window, so sound tracks picture", () => {
    const start = base();
    const e = setSpeed(start, start.clips[0].id, 2);
    expect(audioPieces(e, 0, 5)[0]).toMatchObject({ from: 0, to: 10, dur: 5 });
  });

  test("a gap is silent", () => {
    let e = splitAt(base(), 10);
    e = trimClipEdge(e, e.clips[0].id, "end", 5);
    expect(audioPieces(e, 6, 9)).toEqual([]);
  });

  test("muting the original audio drops the clips but keeps the music", () => {
    const e = setVideoMuted(addSound(base(), { src: "s1", srcDur: 60, at: 0 }), true);
    const pieces = audioPieces(e, 0, 5);
    expect(pieces.length).toBe(1);
    expect(pieces[0]).toMatchObject({ src: "s1", gain: 1 });
  });

  test("a sound plays from where it was trimmed to, at its own volume", () => {
    let e = addSound(base(), { src: "s1", srcDur: 60, at: 4 });
    e = updateEffect(e, soundsOf(e)[0].id, { in: 9, volume: 0.5 });
    const pieces = audioPieces(e, 4, 6);
    const music = pieces.find((p) => p.src === "s1");
    expect(music).toMatchObject({ from: 9, to: 11, at: 0, dur: 2, gain: 0.5 });
  });

  test("a sound that starts inside the window lands where it starts, not at the edge", () => {
    const e = addSound(base(), { src: "s1", srcDur: 60, at: 7 });
    const music = audioPieces(e, 5, 10).find((p) => p.src === "s1");
    expect(music).toMatchObject({ at: 2, dur: 3, from: 0 });
  });

  test("a silent sound is not read at all", () => {
    let e = addSound(base(), { src: "s1", srcDur: 60, at: 0 });
    e = updateEffect(e, soundsOf(e)[0].id, { volume: 0 });
    expect(audioPieces(e, 0, 5).some((p) => p.src === "s1")).toBe(false);
  });

  test("clips and music mix in the same window", () => {
    const e = addSound(base(), { src: "s1", srcDur: 60, at: 0 });
    expect(audioPieces(e, 0, 5).map((p) => p.src).sort()).toEqual(["m1", "s1"]);
  });
});

describe("whether the file needs a sound track at all", () => {
  test("yes when the footage has sound", () => {
    expect(wantsAudio(base(), heard)).toBe(true);
  });

  test("no when the footage is silent and there is no music", () => {
    expect(wantsAudio(base(), () => false)).toBe(false);
  });

  test("no when the original audio is muted and nothing else plays", () => {
    expect(wantsAudio(setVideoMuted(base(), true), heard)).toBe(false);
  });

  test("yes when the original is muted but music plays", () => {
    const e = setVideoMuted(addSound(base(), { src: "s1", srcDur: 60, at: 0 }), true);
    expect(wantsAudio(e, () => false)).toBe(true);
  });
});

describe("mixing a few seconds at a time", () => {
  test("windows cover the edit exactly, with a short last one", () => {
    expect(windows(12, 5)).toEqual([[0, 5], [5, 10], [10, 12]]);
  });

  test("an empty edit still yields one window rather than none", () => {
    expect(windows(0, 5)).toEqual([[0, 0]]);
  });
});

describe("choosing the container from what the browser can encode", () => {
  test("MP4 and H.264 when they are available, because they play everywhere", () => {
    expect(pickOutput({ video: ["avc", "vp9"], audio: ["aac", "opus"] }, true)).toEqual({
      container: "mp4", video: "avc", audio: "aac",
    });
  });

  test("keeping the sound beats keeping the container", () => {
    expect(pickOutput({ video: ["avc", "vp9"], audio: ["opus"] }, true)).toEqual({
      container: "webm", video: "vp9", audio: "opus",
    });
  });

  test("a silent edit takes the most compatible container", () => {
    expect(pickOutput({ video: ["avc", "vp9"], audio: ["opus"] }, false)).toEqual({
      container: "mp4", video: "avc", audio: null,
    });
  });

  test("no audio encoder at all still exports a picture, silently", () => {
    expect(pickOutput({ video: ["avc"], audio: [] }, true)).toEqual({
      container: "mp4", video: "avc", audio: null,
    });
  });

  test("no video encoder means no export", () => {
    expect(pickOutput({ video: [], audio: ["opus"] }, true)).toBeNull();
  });
});

describe("naming the file", () => {
  test("keeps the footage's name and says where it came from", () => {
    expect(exportName("interview.mp4", "mp4")).toBe("interview-cutline.mp4");
  });

  test("survives a name with dots and no extension", () => {
    expect(exportName("holiday.2026.clip", "webm")).toBe("holiday.2026-cutline.webm");
  });

  test("falls back when there is no footage name", () => {
    expect(exportName(undefined, "mp4")).toBe("cutline.mp4");
  });
});
