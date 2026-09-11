import { describe, expect, test } from "bun:test";
import { emptyEdl, type Edl } from "../src/lib/edl/types";
import { addSound, addTrack, insertClip, moveEffect, normalize, setVideoMuted, trimEffect } from "../src/lib/edl/ops";
import { fadeAt, soundsOf, tracksOf, zoomAt } from "../src/lib/edl/query";
import { applyTool, describeState, TOOLS, type AgentContext } from "../src/lib/agent/tools";

const base = () => insertClip(emptyEdl(30), { src: "m1", in: 0, out: 20 }); // a 20s edit
const withSound = (at = 2, srcDur = 60) => addSound(base(), { src: "s1", srcDur, at });
const sound = (e: Edl) => soundsOf(e)[0];

describe("a sound on the sound lane", () => {
  test("lands where asked, at full volume, from the start of its file, no longer than the edit", () => {
    const s = sound(withSound(2, 60));
    expect(s).toMatchObject({ at: 2, in: 0, volume: 1, src: "s1", srcDur: 60 });
    expect(s.dur).toBe(18);
  });

  test("a short file keeps its own length", () => {
    expect(sound(withSound(2, 5)).dur).toBe(5);
  });

  test("dropped past the end, it starts where there is still room", () => {
    const s = sound(withSound(19.9, 60));
    expect(s.at).toBe(19.5);
    expect(s.dur).toBe(0.5);
  });

  test("there is one sound lane, below the picture's lanes, holding every sound", () => {
    let e = addTrack(addTrack(base(), "zoom"), "fade");
    e = addSound(e, { src: "s1", srcDur: 5, at: 0 });
    e = addSound(e, { src: "s2", srcDur: 5, at: 8 });
    expect(tracksOf(e).map((t) => t.kind)).toEqual(["fade", "zoom", "sound"]);
    expect(soundsOf(e).length).toBe(2);
  });

  test("trimming its head moves into the file, so the music under the end stays put", () => {
    const e = withSound(2, 60);
    const t = trimEffect(e, sound(e).id, "start", 5);
    expect(sound(t)).toMatchObject({ at: 5, in: 3, dur: 15 });
  });

  test("its head can't be pulled back before the file begins", () => {
    let e = withSound(2, 60);
    e = trimEffect(e, sound(e).id, "start", 5);
    e = trimEffect(e, sound(e).id, "start", 0);
    expect(sound(e)).toMatchObject({ at: 2, in: 0, dur: 18 });
  });

  test("its tail can't run past the end of the file", () => {
    const e = withSound(2, 5);
    expect(sound(trimEffect(e, sound(e).id, "end", 50)).dur).toBe(5);
  });

  test("moving it keeps the part of the file it plays", () => {
    let e = withSound(2, 60);
    e = trimEffect(e, sound(e).id, "start", 5);
    e = moveEffect(e, sound(e).id, 1);
    expect(sound(e)).toMatchObject({ at: 1, in: 3 });
  });

  test("the picture ignores it", () => {
    const e = withSound(2, 60);
    expect(zoomAt(e, 5)).toBeNull();
    expect(fadeAt(e, 5)).toBeNull();
  });
});

describe("muting the original audio", () => {
  test("is a document flag, stored only while it is on", () => {
    const start = base();
    const muted = setVideoMuted(start, true);
    expect(muted.videoMuted).toBe(true);
    const back = setVideoMuted(muted, false);
    expect("videoMuted" in back).toBe(false);
    expect(JSON.stringify(back)).toBe(JSON.stringify(normalize(start)));
  });

  test("leaves the sound lane alone", () => {
    const e = setVideoMuted(withSound(2, 60), true);
    expect(soundsOf(e).length).toBe(1);
  });
});

describe("the agent and sound", () => {
  const ctx: AgentContext = {
    media: [
      { id: "m1", name: "talk.mp4", duration: 20 },
      { id: "s1", name: "song.mp3", duration: 60, kind: "sound" },
    ],
    analysis: { silences: {} },
  };

  test("every sound tool is offered", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ["set_original_audio", "adjust_lane_item", "remove_lane_item", "clear_lane"]) expect(names).toContain(n);
  });

  test("can mute and unmute the original audio", () => {
    const on = applyTool(base(), ctx, "set_original_audio", { muted: true });
    expect(on.edl.videoMuted).toBe(true);
    expect(applyTool(on.edl, ctx, "set_original_audio", { muted: false }).edl.videoMuted).toBeUndefined();
  });

  test("can move, shorten and quieten a sound in one call", () => {
    const e = withSound(2, 60);
    const r = applyTool(e, ctx, "adjust_lane_item", { item_id: sound(e).id, at: 4, dur: 6, volume: 0.4 });
    expect(sound(r.edl)).toMatchObject({ at: 4, dur: 6, volume: 0.4 });
    expect(r.summary).toContain("40%");
  });

  test("volume is kept between silent and the file's own level", () => {
    const e = withSound(2, 60);
    expect(sound(applyTool(e, ctx, "adjust_lane_item", { item_id: sound(e).id, volume: 3 }).edl).volume).toBe(1);
  });

  test("can remove a sound, leaving its lane", () => {
    const e = withSound(2, 60);
    const r = applyTool(e, ctx, "remove_lane_item", { item_id: sound(e).id });
    expect(soundsOf(r.edl).length).toBe(0);
    expect(tracksOf(r.edl).map((t) => t.kind)).toEqual(["sound"]);
  });

  test("can take all the music off at once, lane and all", () => {
    const e = addSound(withSound(2, 60), { src: "s2", srcDur: 5, at: 10 });
    const r = applyTool(e, ctx, "clear_lane", { kind: "sound" });
    expect(soundsOf(r.edl).length).toBe(0);
    expect(tracksOf(r.edl).length).toBe(0);
  });

  test("a wrong id is an error the model can read, not a change", () => {
    const e = withSound(2, 60);
    const r = applyTool(e, ctx, "adjust_lane_item", { item_id: "nope", volume: 0.1 });
    expect(r.result).toContain("nothing on the lanes");
    expect(r.edl).toBe(e);
  });

  test("the model is told about the sounds and the mute", () => {
    const s = describeState(setVideoMuted(withSound(2, 60), true), ctx);
    expect(s).toContain("song.mp3");
    expect(s).toContain("Original audio: muted");
  });
});
