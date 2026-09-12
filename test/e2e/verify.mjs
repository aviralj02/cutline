import { chromium } from "playwright-core";
import fs from "node:fs";

const OUT = process.env.SHOT_DIR ?? "/tmp";
/** The narrowest window the editor claims to work at. Must match MIN_WIDTH. */
const FLOOR = 860;
const log = (...a) => console.log(...a);
let failures = 0;
const check = (name, ok, detail = "") => {
  log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => log("  [page error]", e.message));
page.on("console", (m) => m.type() === "error" && log("  [console]", m.text().slice(0, 200)));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
log("\n1. App loads");
check("dropzone visible", await page.getByText(/Drop a video/).isVisible());
{
  // The privacy claim is checkable only if the source is reachable from the app.
  // Matched by where it goes, not by what it says: the wording is product copy
  // and will be rewritten, but the destination is the thing being claimed.
  const source = page.locator('a[href*="github.com"]');
  const href = (await source.count()) ? await source.first().getAttribute("href") : null;
  const named = (await source.count()) ? (await source.first().innerText()).trim() : "";
  check("the start screen links to the source", (await source.count()) === 1 && /github\.com\//.test(href ?? ""), href ?? "no link");
  check("and the link says where it goes", named.length > 0, named || "no text");
}

// ---------------------------------------------------------------------------
// Generate test footage in the page: 20s, with deliberate silent stretches.
// ---------------------------------------------------------------------------
log("\n2. Generating 20s test video with known silences (5-8s, 13-16s)");
const madeFile = await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");

  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 200;
  osc.connect(gain).connect(dest);
  // Loud speech-ish tone, with two silent windows carved out.
  gain.gain.setValueAtTime(0.35, ac.currentTime);
  gain.gain.setValueAtTime(0.0, ac.currentTime + 5);
  gain.gain.setValueAtTime(0.35, ac.currentTime + 8);
  gain.gain.setValueAtTime(0.0, ac.currentTime + 13);
  gain.gain.setValueAtTime(0.35, ac.currentTime + 16);
  osc.start();

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();

  const t0 = performance.now();
  await new Promise((resolve) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      ctx.fillStyle = `hsl(${(t * 24) % 360} 45% 22%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 56px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(t.toFixed(1) + "s", 320, 200);
      // A reference feature for the zoom-anchor check. Placed away from the
      // centre text and from the pixel the fade checks sample.
      ctx.fillStyle = "#ff2020";
      ctx.beginPath();
      ctx.arc(640 * 0.62, 360 * 0.62, 7, 0, 7);
      ctx.fill();
      if (t >= 20) resolve();
      else requestAnimationFrame(draw);
    };
    draw();
  });
  rec.stop();
  osc.stop();
  await new Promise((r) => (rec.onstop = r));
  const blob = new Blob(chunks, { type: "video/webm" });
  window.__testVideo = new File([blob], "test-clip.webm", { type: "video/webm" });
  return { size: blob.size };
});
check("recorded test video", madeFile.size > 10000, `${(madeFile.size / 1024).toFixed(0)}KB`);

// ---------------------------------------------------------------------------
log("\n3. Importing (OPFS write + audio decode + silence analysis)");
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(window.__testVideo);
  const input = document.querySelector('input[type="file"]');
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForSelector("text=Timeline", { timeout: 45000 });
check("editor opened after import", true);

const imported = await page.evaluate(() => {
  const txt = document.body.innerText;
  return { text: txt, hasPauses: /Found (\d+) pauses/.exec(txt)?.[1] ?? null };
});
check("silence analysis ran on import", imported.hasPauses !== null, `${imported.hasPauses} pauses found`);
check("found the 2 planted silences", imported.hasPauses === "2", `expected 2, got ${imported.hasPauses}`);

// Mediabunny demux: real frame rate and rotation-corrected display size.
const shown = await page.evaluate(() => {
  const m = /(\d+)×(\d+)/.exec(document.body.innerText);
  return m ? { w: +m[1], h: +m[2] } : null;
});
check("demuxed the real display dimensions", shown?.w === 640 && shown?.h === 360, JSON.stringify(shown));
const fpsUsed = await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open("cutline", 1);
    r.onsuccess = () => res(r.result);
  });
  const rec = await new Promise((res) => {
    const q = db.transaction("project").objectStore("project").get("current");
    q.onsuccess = () => res(q.result);
  });
  const head = rec.repo.branches[rec.repo.current];
  return rec.repo.commits[head].edl.fps;
});
check("detected a real frame rate (not hardcoded)", fpsUsed >= 20 && fpsUsed <= 35, `${fpsUsed}fps`);

await page.screenshot({ path: `${OUT}/01-imported.png` });

// ---------------------------------------------------------------------------
log("\n4. Version control");
const beforeVersions = await page.getByText("Import test-clip.webm").count();
check("import committed as first version", beforeVersions >= 1);

// Put the playhead mid-clip first: splitting on a boundary is correctly a no-op.
const track = page.getByRole("slider", { name: "Playhead" });
const box = await track.boundingBox();
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
await page.waitForTimeout(300);
await page.getByRole("button", { name: /^Split/ }).click();
await page.waitForTimeout(400);
const afterSplit = await page.evaluate(() => document.body.innerText.includes("Split at"));
check("manual edit created a new version", afterSplit);

// ---------------------------------------------------------------------------
log("\n5. Timeline reflects the edit");
const clipCount = await page.evaluate(() => {
  const m = /(\d+) clips?/.exec(document.body.innerText);
  return m ? +m[1] : 0;
});
check("split produced 2 clips", clipCount === 2, `${clipCount} clips`);

// ---------------------------------------------------------------------------
log("\n6. Restoring an earlier version");
await page.getByText("Import test-clip.webm").first().hover();
await page.waitForTimeout(200);
const restoreBtn = page.getByRole("button", { name: "restore" }).first();
if (await restoreBtn.count()) {
  await restoreBtn.click();
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => {
    const m = /(\d+) clips?/.exec(document.body.innerText);
    return m ? +m[1] : 0;
  });
  check("restore returned to 1 clip", back === 1, `${back} clips`);
} else {
  check("restore control present", false, "not found");
}

// ---------------------------------------------------------------------------
log("\n7. Playback");
await page.getByRole("button", { name: "Play", exact: true }).click();
await page.waitForTimeout(1500);
const advanced = await page.evaluate(() => {
  const m = /(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
  return m ? +m[1] * 60 + +m[2] + +m[3] / 100 : 0;
});
check("playhead advanced during playback", advanced > 0.3, `at ${advanced.toFixed(2)}s`);
await page.screenshot({ path: `${OUT}/02-playing.png` });

// ---------------------------------------------------------------------------
log("\n8. Reload persistence (OPFS + IndexedDB)");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const survived = await page.evaluate(() => document.body.innerText.includes("Timeline"));
check("project survived a reload", survived);
await page.screenshot({ path: `${OUT}/03-reloaded.png` });

// ---------------------------------------------------------------------------
log("\n9. Scrubbing lives on the ruler, editing lives on the track");
{
  const ruler = page.getByRole("slider", { name: "Playhead" });
  const b = await ruler.boundingBox();
  const readHead = () =>
    page.evaluate(() => {
      const m = /(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
      return m ? +m[1] * 60 + +m[2] + +m[3] / 100 : -1;
    });

  await page.mouse.move(b.x + b.width * 0.15, b.y + b.height / 2);
  await page.mouse.down();
  const atPress = await readHead();
  await page.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 12 });
  const atDrag = await readHead();
  await page.mouse.up();

  check("pressing the ruler seeks", atPress > 0.5 && atPress < 6, `${atPress.toFixed(2)}s`);
  check("holding and dragging the ruler scrubs", atDrag > atPress + 5,
        `${atPress.toFixed(2)}s to ${atDrag.toFixed(2)}s`);

  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2, { steps: 5 });
  const afterRelease = await readHead();
  check("releasing ends the drag", Math.abs(afterRelease - atDrag) < 0.2, `${afterRelease.toFixed(2)}s`);

  // The track is for editing now: clicking a clip must select without seeking,
  // or a gesture would have to guess which of the two you meant.
  const before = await readHead();
  const clip = await page.locator("[data-clip]").first().boundingBox();
  await page.mouse.click(clip.x + clip.width * 0.5, clip.y + clip.height / 2);
  await page.waitForTimeout(300);
  const after = await readHead();
  check("clicking a clip does not move the playhead", Math.abs(after - before) < 0.05,
        `${before.toFixed(2)}s to ${after.toFixed(2)}s`);
  check("clicking a clip selects it",
        (await page.getByRole("group", { name: "Clip speed" }).count()) === 1);
}

// ---------------------------------------------------------------------------
log("\n10. Crop, and undoing a crop");
{
  await page.getByRole("button", { name: "Crop" }).click();
  await page.waitForTimeout(300);
  check("crop handles appear", await page.getByRole("button", { name: /Resize crop/ }).first().isVisible());

  await page.getByRole("button", { name: "9:16" }).click();
  await page.waitForTimeout(400);
  const vertical = await page.evaluate(() => /(\d+) × (\d+)/.exec(document.body.innerText)?.slice(1).map(Number));
  check("9:16 produces a portrait frame", vertical && vertical[0] < vertical[1], JSON.stringify(vertical));
  check("crop is even-numbered and encodable", vertical && vertical[0] % 2 === 0 && vertical[1] % 2 === 0);

  const croppedVersions = await page.getByText(/Crop to 9:16/).count();
  check("the crop is a version you can go back to", croppedVersions > 0);

  await page.getByRole("button", { name: "Reset" }).click();
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => document.body.innerText.includes("Reset crop"));
  check("reset restores the full frame", restored);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
log("\n11. Clip speed");
{
  await page.locator("[data-clip]").first().click();
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => /of (\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText));
  await page.getByRole("button", { name: "2×", exact: true }).click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => document.body.innerText.includes("Speed 2×"));
  check("2× is applied and versioned", after);

  await page.getByRole("button", { name: "1×", exact: true }).click();
  await page.waitForTimeout(400);
  check("speed returns to normal", await page.evaluate(() => document.body.innerText.includes("Normal speed")));
  void before;
}

// ---------------------------------------------------------------------------
log("\n12. Controls actually render their contents");
{
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => !b.textContent.trim() && !b.querySelector("svg"))
      .map((b) => b.getAttribute("aria-label") || "(unlabelled)"),
  );
  check("no icon button renders empty", bad.length === 0, bad.join(", ") || "all draw content");

  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => !b.textContent.trim() && !b.getAttribute("aria-label") && !b.getAttribute("title"))
      .length,
  );
  check("every icon-only control has an accessible name", unnamed === 0, `${unnamed} unnamed`);

  // Radius must resolve to a real length — an invalid custom-property class
  // silently computes to 0px and every control ships square.
  const square = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null && b.textContent.trim())
      .filter((b) => parseFloat(getComputedStyle(b).borderTopLeftRadius) < 1).length,
  );
  check("text buttons have a resolved corner radius", square === 0, `${square} square`);

  // A control whose glyph is the same value as its own fill is invisible.
  // Two Tailwind colour utilities on one element tie on specificity, so an
  // override can silently lose and ship a grey icon on an amber button.
  const lowContrast = await page.evaluate(() => {
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return [...document.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null && b.querySelector("svg"))
      .map((b) => {
        const cs = getComputedStyle(b);
        const bg = cs.backgroundColor;
        if (!bg || /rgba?\(0, 0, 0, 0\)/.test(bg)) return null;
        const a = lum(cs.color) + 0.05;
        const z = lum(bg) + 0.05;
        const ratio = Math.max(a, z) / Math.min(a, z);
        return ratio < 3 ? `${b.getAttribute("aria-label") || "?"} ${ratio.toFixed(2)}:1` : null;
      })
      .filter(Boolean);
  });
  check("icons contrast against their own button", lowContrast.length === 0, lowContrast.join(", ") || "all >= 3:1");
}

// ---------------------------------------------------------------------------
log("\n13. Waveforms carry shape, not just presence");
{
  const w = await page.evaluate(() => {
    const clip = document.querySelector("[data-bar]")?.parentElement;
    if (!clip) return null;
    const h = clip.getBoundingClientRect().height;
    const bars = [...clip.querySelectorAll("[data-bar]")].map((b) => b.getBoundingClientRect().height);
    if (!bars.length || !h) return null;
    const sorted = [...bars].sort((a, b) => a - b);
    return {
      count: bars.length,
      peakFrac: Math.max(...bars) / h,
      medianFrac: sorted[Math.floor(sorted.length / 2)] / h,
      quietFrac: sorted[0] / h,
    };
  });

  check("the waveform is drawn", w && w.count > 20, w ? `${w.count} bars` : "none");
  // Envelopes are normalised per file, so loud passages must reach most of
  // the clip. Scaling by absolute amplitude once left these at 20%.
  check("loud passages fill the clip", w && w.peakFrac > 0.6, w && `peak ${(w.peakFrac * 100).toFixed(0)}%`);
  check("the envelope has dynamic range", w && w.medianFrac > 0.15, w && `median ${(w.medianFrac * 100).toFixed(0)}%`);
  check("silence reads as flat", w && w.quietFrac < 0.12, w && `quietest ${(w.quietFrac * 100).toFixed(0)}%`);

  // A radius inside a non-uniformly scaled SVG renders as a flattened
  // ellipse, so the caps must come from CSS pixels.
  const caps = await page.evaluate(() => {
    const b = document.querySelector("[data-bar]");
    if (!b) return null;
    const cs = getComputedStyle(b);
    const w = b.getBoundingClientRect().width;
    return { radius: parseFloat(cs.borderTopLeftRadius), width: w, tag: b.tagName };
  });
  check(
    "bars have round caps in real pixels",
    caps && caps.tag !== "rect" && caps.radius >= caps.width / 2 - 0.6,
    caps && `r=${caps.radius.toFixed(1)}px on ${caps.width.toFixed(1)}px wide`,
  );
}

// ---------------------------------------------------------------------------
log("\n14. Ruler labels never collide, at any speed");
{
  const overlaps = () =>
    page.evaluate(() => {
      const row = document.querySelector('[aria-label="Playhead"]');
      if (!row) return -1;
      const boxes = [...row.querySelectorAll("span.tnum")]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 0)
        .sort((a, b) => a.left - b.left);
      let hits = 0;
      for (let i = 1; i < boxes.length; i++) if (boxes[i].left < boxes[i - 1].right + 2) hits++;
      return hits;
    });

  await page.locator("[data-clip]").first().click();
  await page.waitForTimeout(300);

  // Suppressing a label that would be cut in half is one line away from
  // suppressing all of them, and a collision count of zero cannot tell the
  // difference — so assert they are actually there.
  const labels = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Playhead"] span.tnum')].map((e) => e.textContent));
  const shown = await labels();
  check("the ruler is actually labelled", shown.length >= 3, `${shown.length} labels`);
  check("and it starts at zero", shown[0] === "0:00.00", shown[0] ?? "none");

  check("labels are clear at 1x", (await overlaps()) === 0);

  await page.getByRole("button", { name: "0.5×", exact: true }).click();
  await page.waitForTimeout(500);
  check("labels stay clear at 0.5x", (await overlaps()) === 0, "half speed doubles the timeline");

  await page.getByRole("button", { name: "2×", exact: true }).click();
  await page.waitForTimeout(500);
  check("labels stay clear at 2x", (await overlaps()) === 0);

  // Narrow windows are where labels actually collide: the ruler loses width
  // while the number of ticks stays the same. FLOOR is the narrowest the
  // editor claims to work at — below it the window gets a wall instead.
  await page.setViewportSize({ width: FLOOR, height: 720 });
  await page.waitForTimeout(600);
  check("labels are clear on a narrow window", (await overlaps()) === 0);

  await page.getByRole("button", { name: "0.5×", exact: true }).click();
  await page.waitForTimeout(600);
  check("labels stay clear narrow at 0.5x", (await overlaps()) === 0);

  // The rule guarantees a minimum spacing, so assert the spacing itself
  // rather than only the absence of a collision.
  const gap = await page.evaluate(() => {
    const row = document.querySelector('[aria-label="Playhead"]');
    const boxes = [...row.querySelectorAll("span.tnum")]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0)
      .sort((a, b) => a.left - b.left);
    let min = Infinity;
    for (let i = 1; i < boxes.length; i++) min = Math.min(min, boxes[i].left - boxes[i - 1].right);
    return boxes.length > 1 ? min : 999;
  });
  check("labels keep clear space between them", gap >= 6, `${gap.toFixed(1)}px apart`);

  await page.getByRole("button", { name: "1×", exact: true }).click();
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
log("\n15. Effect lanes: fade and zoom actually render");
{
  const sample = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas");
      const ctx = c.getContext("2d", { willReadFrequently: true });
      // Off-centre on purpose: the test clip draws white timecode text dead
      // centre, which pins any sample there to 255 regardless of the fade.
      const d = ctx.getImageData(Math.floor(c.width * 0.2), Math.floor(c.height * 0.25), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], lum: 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2] };
    });

  await page.getByRole("button", { name: "Add fade track" }).click();
  await page.waitForTimeout(300);
  check("a fade lane appears", (await page.getByRole("button", { name: "Add to Fade" }).count()) > 0);

  // Park the playhead, then drop a fade on it.
  const t = page.getByRole("slider", { name: "Playhead" });
  const b = await t.boundingBox();
  await page.mouse.click(b.x + b.width * 0.3, b.y + b.height / 2);
  await page.waitForTimeout(300);
  const before = await sample();

  await page.getByRole("button", { name: "Add to Fade" }).click();
  await page.waitForTimeout(400);
  check("the inspector opens on the new effect", await page.getByRole("group", { name: "Fade colour" }).isVisible());

  // Re-measure: anything that changes the card's height moves every lane.
  const lane2 = await page.getByRole("slider", { name: "Playhead" }).boundingBox();
  const fadeBox = await page.locator("[data-effect]").first().boundingBox();
  // A fade out is opaque near its end, so the picture should darken there.
  await page.mouse.click(fadeBox.x + fadeBox.width * 0.88, lane2.y + lane2.height / 2);
  await page.waitForTimeout(500);
  const during = await sample();
  check("fade to black darkens the picture", during.lum < before.lum - 12,
        `${before.lum.toFixed(0)} to ${during.lum.toFixed(0)}`);

  // Seeking on the video lane selects the clip, which closes the effect
  // inspector — selection is exclusive by design. Re-select the fade.
  await page.locator("[data-effect]").first().click();
  await page.waitForTimeout(300);
  check("clicking an effect re-opens its inspector",
        await page.getByRole("group", { name: "Fade colour" }).isVisible());

  // Recolour it and the wash should follow.
  await page.getByRole("button", { name: "White", exact: true }).click();
  await page.waitForTimeout(500);
  const white = await sample();
  check("the palette changes the fade colour", white.lum > during.lum + 12,
        `${during.lum.toFixed(0)} to ${white.lum.toFixed(0)}`);

  const versioned = await page.getByText("Fade colour").count();
  check("changing the colour is versioned", versioned > 0);
}

// ---------------------------------------------------------------------------
log("\n16. Trim handles move one edge only");
{
  const read = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-effect]");
      const lane = el.parentElement.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { left: (r.left - lane.left) / lane.width, right: (r.right - lane.left) / lane.width };
    });

  const start = await read();
  const el = await page.locator("[data-effect]").first().boundingBox();
  // Drag the right handle further right.
  await page.mouse.move(el.x + el.width - 3, el.y + el.height / 2);
  await page.mouse.down();
  await page.mouse.move(el.x + el.width + 90, el.y + el.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await read();

  check("trimming the end extends it", after.right > start.right + 0.02,
        `${(start.right * 100).toFixed(1)}% to ${(after.right * 100).toFixed(1)}%`);
  check("trimming the end leaves the start alone", Math.abs(after.left - start.left) < 0.012,
        `start moved ${((after.left - start.left) * 100).toFixed(2)}%`);
  check("the trim is versioned", (await page.getByText("Trim effect").count()) > 0);
}

// ---------------------------------------------------------------------------
log("\n17. One lane per kind, one version per gesture");
{
  const laneCount = async (name) => page.getByRole("button", { name: `Add to ${name}` }).count();

  check("the fade lane exists", (await laneCount("Fade")) === 1);
  check("the add-fade-lane control is gone once it exists",
        (await page.getByRole("button", { name: "Add fade track" }).count()) === 0);

  await page.getByRole("button", { name: "Add zoom track" }).click();
  await page.waitForTimeout(400);
  check("a zoom lane can still be added", (await laneCount("Zoom")) === 1);
  check("and then its control disappears too",
        (await page.getByRole("button", { name: "Add zoom track" }).count()) === 0);

  await page.getByRole("button", { name: "Add to Zoom" }).click();
  await page.waitForTimeout(400);

  const versions = () => page.evaluate(() =>
    document.body.innerText.split("\n").filter((l) => /^(Zoom|Add|Trim|Fade|Move) /.test(l.trim())).length);

  const before = await versions();
  // Drag the scale slider across its range. Every input event would be a
  // version if the draft were not coalescing them.
  const slider = page.locator('input[type="range"]').first();
  const sb = await slider.boundingBox();
  await page.mouse.move(sb.x + sb.width * 0.2, sb.y + sb.height / 2);
  await page.mouse.down();
  for (const f of [0.35, 0.5, 0.65, 0.8]) {
    await page.mouse.move(sb.x + sb.width * f, sb.y + sb.height / 2);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await versions();

  check("a slider drag writes exactly one version", after - before === 1, `${after - before} added`);
  check("and the value actually changed",
        (await page.getByText(/Zoom scale/).count()) > 0);
}

// ---------------------------------------------------------------------------
log("\n18. The zoom focus is set on the picture, not by sliders");
{
  // Select the zoom that section 17 left on the lane.
  await page.locator("[data-effect]").last().click();
  await page.waitForTimeout(400);

  const target = page.getByRole("button", { name: /Zoom focus/ });
  check("a focal target appears over the picture", (await target.count()) === 1);
  check("the X and Y sliders are gone",
        (await page.locator('input[type="range"]').count()) === 2, "scale and ease only");

  const readFocus = () =>
    page.evaluate(() => {
      const m = /Currently (\d+) percent across, (\d+) percent down/.exec(
        document.querySelector('[aria-label*="Zoom focus"]')?.getAttribute("aria-label") ?? "",
      );
      return m ? { x: +m[1], y: +m[2] } : null;
    });

  const before = await readFocus();
  const versionsBefore = await page.evaluate(() =>
    document.body.innerText.split("\n").filter((l) => /^Zoom focus/.test(l.trim())).length);

  const box = await target.boundingBox();
  const canvas = await page.locator("canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.25, canvas.y + canvas.height * 0.7, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = await readFocus();
  check("dragging the target moves the focus",
        after && before && (Math.abs(after.x - before.x) > 8 || Math.abs(after.y - before.y) > 8),
        `${before?.x},${before?.y} to ${after?.x},${after?.y}`);
  check("it lands where it was dropped", after && after.x > 15 && after.x < 40 && after.y > 55,
        `${after?.x}%, ${after?.y}%`);

  const versionsAfter = await page.evaluate(() =>
    document.body.innerText.split("\n").filter((l) => /^Zoom focus/.test(l.trim())).length);
  check("one drag, one version", versionsAfter - versionsBefore === 1, `${versionsAfter - versionsBefore} added`);

  // Keyboard has to work too, since the sliders it replaced were reachable.
  await target.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(350);
  const nudged = await readFocus();
  check("arrow keys nudge the focus", nudged && nudged.x < after.x, `${after?.x}% to ${nudged?.x}%`);
}

// ---------------------------------------------------------------------------
log("\n19. The zoom anchors exactly on its marker");
{
  /**
   * The fixed-point property: a scale about F leaves F itself unmoved. So put
   * the focus on a known feature and check the feature does not move.
   *
   * Solving for the anchor from how a feature moves also works, but it divides
   * by (1 - s), so a few percent of error in the estimated scale becomes a few
   * percent of phantom offset. This version needs no estimate at all.
   */
  const dot = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas");
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let bx = 0, by = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 165 && data[i + 1] < 95 && data[i + 2] < 95) {
          const p = i / 4; bx += p % c.width; by += Math.floor(p / c.width); n++;
        }
      }
      return n ? { x: bx / n / c.width, y: by / n / c.height, n } : null;
    });

  // Earlier sections left a white fade over the same stretch as the zoom,
  // which washes the reference marker out of the frame.
  await page.locator("[data-effect]").first().click();
  await page.waitForTimeout(300);
  // Exact: the lane header also has a "Remove Fade track" control.
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator("[data-effect]").last().click();
  await page.waitForTimeout(300);

  const sc = page.locator('input[type="range"]').first();
  const scb = await sc.boundingBox();
  await page.mouse.click(scb.x + scb.width * 0.25, scb.y + scb.height / 2);
  await page.waitForTimeout(400);

  // Drop the focus exactly on the reference marker the clip draws.
  const canvas = await page.locator("canvas").boundingBox();
  const tb = await page.getByRole("button", { name: /Zoom focus/ }).boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.62, canvas.y + canvas.height * 0.62, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const zoomItem = await page.locator("[data-effect]").last().boundingBox();
  const lane = await page.getByRole("slider", { name: "Playhead" }).boundingBox();
  // Seek relative to the material, not to the ruler: the ruler holds its
  // extent after a trim, so its far end can be past the last frame — where
  // there is nothing to sample.
  const lastClip = await page.locator("[data-clip]").last().boundingBox();
  const endOfEdit = lastClip.x + lastClip.width - 6;

  await page.mouse.click(endOfEdit, lane.y + lane.height / 2);
  await page.waitForTimeout(500);
  const flat = await dot();

  await page.locator("[data-effect]").last().click();
  await page.waitForTimeout(300);
  await page.mouse.click(zoomItem.x + zoomItem.width * 0.5, lane.y + lane.height / 2);
  await page.waitForTimeout(600);
  const zoomed = await dot();

  check("the reference marker is visible at both scales", !!flat && !!zoomed,
        `${flat ? "found" : "missing"} / ${zoomed ? "found" : "missing"}`);

  if (flat && zoomed) {
    check("the zoom actually magnifies", zoomed.n > flat.n * 1.4,
          `area ${flat.n} to ${zoomed.n}`);
    check("the focal point does not move horizontally", Math.abs(zoomed.x - flat.x) < 0.012,
          `drift ${((zoomed.x - flat.x) * 100).toFixed(2)}%`);
    check("the focal point does not move vertically", Math.abs(zoomed.y - flat.y) < 0.012,
          `drift ${((zoomed.y - flat.y) * 100).toFixed(2)}%`);
  }
}

// ---------------------------------------------------------------------------
log("\n19b. Backspace deletes a selected effect, the way it deletes a clip");
{
  const effects = () => page.locator("[data-effect]").count();
  const lanes = () => page.getByRole("button", { name: /^Remove .* track$/ }).count();
  const n0 = await effects();
  const l0 = await lanes();

  await page.locator("[data-effect]").last().click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);

  check("the selected effect is gone", (await effects()) === n0 - 1, `${n0} to ${await effects()}`);
  check("its lane stays", (await lanes()) === l0, `${l0} to ${await lanes()}`);
  check("the inspector lets go of it",
        await page.getByText("Select a fade, zoom or sound to adjust it").isVisible());
  check("it is one version, named for what it did",
        (await page.getByText("Remove zoom", { exact: true }).count()) === 1);

  // Later sections were written against the zoom still being here.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  check("and undo brings it back", (await effects()) === n0);
}

// ---------------------------------------------------------------------------
log("\n20. A trim moves only the edge you drag");
{
  const total = () =>
    page.evaluate(() => {
      const m = /(\d+):(\d\d)\.(\d\d)\s*\/\s*(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
      return m ? +m[4] * 60 + +m[5] + +m[6] / 100 : -1;
    });
  const firstClip = () => page.locator("[data-clip]").first().boundingBox();
  const lastClip = () => page.locator("[data-clip]").last().boundingBox();
  const gaps = () => page.locator("[data-gap]").count();

  // --- the head: its left edge follows the pointer, and its end stays ---
  const before = await total();
  const c0 = await firstClip();
  await page.mouse.move(c0.x + 3, c0.y + c0.height / 2);
  await page.mouse.down();
  await page.mouse.move(c0.x + 110, c0.y + c0.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const c1 = await firstClip();
  check("trimming the head moves the head", c1.x > c0.x + 80, `left edge moved ${(c1.x - c0.x).toFixed(1)}px`);
  check("and leaves the clip's end where it was", Math.abs(c1.x + c1.width - (c0.x + c0.width)) < 2,
        `right edge moved ${(c1.x + c1.width - c0.x - c0.width).toFixed(1)}px`);
  check("a gap holds the space, so the edit keeps its length",
        (await gaps()) === 1 && Math.abs((await total()) - before) < 0.05,
        `${await gaps()} gap(s), ${before.toFixed(2)}s to ${(await total()).toFixed(2)}s`);
  check("the trim is one version", (await page.getByText("Trim clip").count()) > 0);
  // For design review: the gap as it first appears on the track.
  await page.locator("[data-gap]").first().locator("xpath=ancestor::div[contains(@class,'rounded-panel')][1]")
    .screenshot({ path: `${OUT}/gap.png` }).catch(() => {});

  // --- playback runs through the gap as black, rather than stopping at it ---
  const gapSec = parseFloat(((await page.locator("[data-gap]").first().getAttribute("aria-label")) ?? "").match(/[\d.]+/)?.[0] ?? "0");
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(gapSec * 1000 + 900);
  const at = +((await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuenow")) ?? 0);
  const playing = await page.getByRole("button", { name: "Pause", exact: true }).isVisible();
  if (playing) await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(300);
  check("playback runs through a gap and on into the clip", playing && at > gapSec + 0.2,
        `playhead at ${at}s past a ${gapSec}s gap, ${playing ? "still playing" : "stopped"}`);

  // --- the last clip's tail: the edit ends earlier, and the head stays ---
  const l0 = await lastClip();
  const afterHead = await total();
  await page.mouse.move(l0.x + l0.width - 3, l0.y + l0.height / 2);
  await page.mouse.down();
  await page.mouse.move(l0.x + l0.width - 90, l0.y + l0.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const l1 = await lastClip();
  check("trimming the tail leaves the head where it was", Math.abs(l1.x - l0.x) < 2,
        `moved ${(l1.x - l0.x).toFixed(1)}px`);
  check("trimming the last clip's tail shortens the edit", (await total()) < afterHead - 0.3,
        `${afterHead.toFixed(2)}s to ${(await total()).toFixed(2)}s`);

  // --- a gap is closed the way a clip is deleted ---
  const beforeClose = await total();
  await page.locator("[data-gap]").first().click();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);
  check("selecting a gap and pressing Backspace closes it",
        (await gaps()) === 0 && (await total()) < beforeClose - 0.3,
        `${beforeClose.toFixed(2)}s to ${(await total()).toFixed(2)}s`);
  check("as one version, named for what it did", (await page.getByText("Close gap", { exact: true }).count()) === 1);
}

// ---------------------------------------------------------------------------
log("\n21. Undo takes the version with it");
{
  const versionCount = () =>
    page.evaluate(() => document.querySelectorAll('[class*="group"] p.truncate').length);
  const duration = () =>
    page.evaluate(() => {
      const m = /(\d+):(\d\d)\.(\d\d)\s*\/\s*(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
      return m ? +m[4] * 60 + +m[5] + +m[6] / 100 : -1;
    });

  const beforeCount = await versionCount();
  const beforeDur = await duration();

  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(500);

  check("undo restores the previous state", (await duration()) !== beforeDur,
        `${beforeDur.toFixed(2)}s to ${(await duration()).toFixed(2)}s`);
  check("undo REMOVES the entry rather than adding one",
        (await versionCount()) === beforeCount - 1,
        `${beforeCount} to ${await versionCount()}`);

  const midDur = await duration();
  await page.getByRole("button", { name: "Redo" }).click();
  await page.waitForTimeout(500);
  check("redo puts it back", Math.abs((await duration()) - beforeDur) < 0.05,
        `${midDur.toFixed(2)}s to ${(await duration()).toFixed(2)}s`);
  check("redo restores the entry too", (await versionCount()) === beforeCount);

  // Redo must not survive a new edit.
  await page.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /^Split/ }).click();
  await page.waitForTimeout(400);
  const redoDisabled = await page.evaluate(() =>
    document.querySelector('[aria-label="Redo"]')?.disabled);
  check("a new edit discards the redo stack", redoDisabled === true);
}

// ---------------------------------------------------------------------------
log("\n22. Adding more media to the same project");
{
  const clipsBefore = await page.locator("[data-clip]").count();
  const durBefore = await page.evaluate(() => {
    const m = /(\d+):(\d\d)\.(\d\d)\s*\/\s*(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
    return m ? +m[4] * 60 + +m[5] + +m[6] / 100 : -1;
  });

  // Record a second, shorter clip and feed it to the lane's own file input.
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 360;
    const ctx = c.getContext("2d");
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); const g = ac.createGain();
    osc.connect(g).connect(dest); g.gain.value = 0.3; osc.start();
    const st = c.captureStream(30);
    dest.stream.getAudioTracks().forEach((t) => st.addTrack(t));
    const rec = new MediaRecorder(st, { mimeType: "video/webm;codecs=vp8,opus" });
    const ch = [];
    rec.ondataavailable = (e) => e.data.size && ch.push(e.data);
    rec.start();
    const t0 = performance.now();
    await new Promise((res) => {
      const d = () => {
        const t = (performance.now() - t0) / 1000;
        ctx.fillStyle = "#5a3a20"; ctx.fillRect(0, 0, 640, 360);
        if (t >= 6) res(); else requestAnimationFrame(d);
      }; d();
    });
    rec.stop(); osc.stop(); await new Promise((r) => (rec.onstop = r));
    const f = new File([new Blob(ch, { type: "video/webm" })], "b-roll.webm", { type: "video/webm" });
    const dt = new DataTransfer(); dt.items.add(f);
    const input = document.querySelector('input[aria-label="Add another video"]');
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(6000);

  const clipsAfter = await page.locator("[data-clip]").count();
  const durAfter = await page.evaluate(() => {
    const m = /(\d+):(\d\d)\.(\d\d)\s*\/\s*(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
    return m ? +m[4] * 60 + +m[5] + +m[6] / 100 : -1;
  });

  check("a second file appends a clip to the same track", clipsAfter === clipsBefore + 1,
        `${clipsBefore} to ${clipsAfter} clips`);
  check("the timeline gets longer", durAfter > durBefore + 3,
        `${durBefore.toFixed(2)}s to ${durAfter.toFixed(2)}s`);
  check("adding media is a version", (await page.getByText("Add b-roll.webm").count()) > 0);
  check("the new clip draws its own waveform",
        (await page.locator("[data-clip]").last().locator("[data-bar]").count()) > 5);
}

// ---------------------------------------------------------------------------
log("\n23. The transport never swallows a toolbar click");
{
  // It floats over the timeline card by design. A floating panel above an
  // interactive row is only safe if nothing interactive is ever under it, and
  // the toolbar's width changes with the window and with what is selected.
  const stolenAt = async (width) => {
    await page.setViewportSize({ width, height: 940 });
    await page.waitForTimeout(450);
    await page.locator("[data-clip]").first().click({ force: true });
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const panel = document
        .querySelector('[aria-label="Play"], [aria-label="Pause"]')
        ?.closest("div.rounded-full");
      if (!panel) return -1;
      const t = panel.getBoundingClientRect();
      return [...document.querySelectorAll("button, [role='slider']")]
        .filter((el) => el.offsetParent !== null && !panel.contains(el))
        .map((el) => ({ el, b: el.getBoundingClientRect() }))
        .filter(({ b }) => b.width && b.height)
        .filter(({ b }) => !(b.right < t.left || b.left > t.right || b.bottom < t.top || b.top > t.bottom))
        .filter(({ el, b }) => {
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return hit && !el.contains(hit) && !hit.contains(el);
        }).length;
    });
  };

  // Covered is not the only way to lose a control: squeezed, it is clipped by
  // the card around it or wraps out of its row. Measured with a clip selected,
  // which is when the toolbar is at its widest.
  const spillAt = () =>
    page.evaluate(() => {
      const heading = (text, scope = document) =>
        [...scope.querySelectorAll("h2")].find((h) => h.textContent === text);
      const rows = {
        "app header": document.querySelector("header"),
        "timeline card": heading("Timeline")?.parentElement?.parentElement,
        "Ask header": heading("Ask")?.parentElement,
        "Versions header": heading("Versions")?.parentElement,
      };
      const out = {};
      for (const [name, row] of Object.entries(rows)) {
        if (!row) {
          out[name] = "missing";
          continue;
        }
        const r = row.getBoundingClientRect();
        let spill = 0;
        for (const el of row.querySelectorAll("button, h2, label, span")) {
          // The lanes scroll sideways on purpose; only the chrome must fit.
          if (el.closest(".overflow-x-auto")) continue;
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          spill = Math.max(spill, b.right - r.right, r.left - b.left, b.bottom - r.bottom, r.top - b.top);
        }
        out[name] = Math.round(spill);
      }
      out.page = document.documentElement.scrollWidth - window.innerWidth;
      return out;
    });

  // Fitting is not the same as having room. The toolbar is the tightest row:
  // this is the space left between its label and its controls.
  const toolbarSlack = () =>
    page.evaluate(() => {
      const row = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Timeline")?.parentElement;
      const count = row?.querySelector(":scope > span");
      const controls = row?.querySelector(":scope > div");
      if (!count || !controls) return -1;
      return Math.round(controls.getBoundingClientRect().left - count.getBoundingClientRect().right);
    });

  // Prove the measure can fail: push a control out of the toolbar on purpose.
  await page.locator("[data-clip]").first().click({ force: true });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Timeline")?.parentElement;
    const probe = document.createElement("button");
    probe.id = "spill-probe";
    probe.style.cssText = "flex-shrink:0;width:3000px;height:20px";
    row?.querySelector(":scope > div")?.append(probe);
  });
  const probed = await spillAt();
  await page.evaluate(() => document.getElementById("spill-probe")?.remove());
  check("the spill measure catches a control pushed out of its row",
        typeof probed["timeline card"] === "number" && probed["timeline card"] > 1,
        `${probed["timeline card"]}px`);

  for (const w of [1680, 1440, 1280, 1100, 1024, 920, 900, 880, 860].filter((w) => w >= FLOOR)) {
    const n = await stolenAt(w);
    check(`no clicks stolen at ${w}px`, n === 0, n < 0 ? "transport not found" : `${n} stolen`);
    const spill = await spillAt();
    const worst = Object.entries(spill).filter(([, v]) => v === "missing" || v > 1);
    check(`nothing spills out of its row at ${w}px`, worst.length === 0,
          worst.length
            ? worst.map(([k, v]) => `${k} ${v === "missing" ? v : `${v}px`}`).join(", ")
            : `toolbar has ${await toolbarSlack()}px to spare`);
    if (w === FLOOR) await page.screenshot({ path: `${OUT}/floor-${FLOOR}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
log("\n24. The timeline holds its room, scrolls, and refuses a narrow window");
{
  const scroller = () =>
    page.evaluate(() => {
      const el = document.querySelector('[aria-label="Playhead"]').closest("div.overflow-x-auto");
      return { w: el.scrollWidth, view: el.clientWidth, left: Math.round(el.scrollLeft) };
    });
  const dur = () =>
    page.evaluate(() => +document.querySelector('[aria-label="Playhead"]').getAttribute("aria-valuemax"));
  const clipBox = () => page.locator("[data-clip]").last().boundingBox();

  const fitBtn = page.getByRole("button", { name: "Fit", exact: true });
  if (await fitBtn.isEnabled()) await fitBtn.click();
  await page.waitForTimeout(400);

  // --- a trim must not rescale the timeline under the hand doing it -------
  const d0 = await dur();
  const b0 = await clipBox();
  // An untouched clip is the witness: if the timeline refits, every clip is
  // redrawn wider, including the ones the trim never touched.
  const witness0 = await page.locator("[data-clip]").first().boundingBox();
  await page.mouse.move(b0.x + b0.width - 3, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width * 0.6, b0.y + b0.height / 2, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const d1 = await dur();
  const b1 = await clipBox();

  check("a trim shortens the edit", d1 < d0 - 0.5, `${d0.toFixed(2)}s to ${d1.toFixed(2)}s`);
  // If the timeline had refit, the shorter clip would occupy the same pixels.
  const shrank = b1.width / b0.width;
  check("the clip shrinks on screen with the edit", shrank < 0.95, `width ×${shrank.toFixed(2)}`);
  const witness1 = await page.locator("[data-clip]").first().boundingBox();
  check("an untrimmed clip does not move or resize",
        Math.abs(witness1.width - witness0.width) < 1.5 && Math.abs(witness1.x - witness0.x) < 1.5,
        `width ${witness0.width.toFixed(1)} to ${witness1.width.toFixed(1)}px`);

  // --- and the room left behind is usable --------------------------------
  await page.mouse.move(b1.x + b1.width - 3, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width * 1.4, b1.y + b1.height / 2, { steps: 16 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const d2 = await dur();
  check("the held room can be trimmed back into", d2 > d1 + 0.5, `${d1.toFixed(2)}s to ${d2.toFixed(2)}s`);

  // --- scale and scroll ---------------------------------------------------
  const flat = await scroller();
  check("at 1x the timeline fits the window", flat.w <= flat.view + 2, `${flat.w} in ${flat.view}`);

  await page.getByRole("button", { name: "Show less time" }).click();
  await page.getByRole("button", { name: "Show less time" }).click();
  await page.waitForTimeout(400);
  const wide = await scroller();
  check("zooming in makes it scrollable", wide.w > wide.view * 2, `${wide.w} in ${wide.view}`);

  const bar = page.getByRole("slider", { name: "Timeline position" });
  check("a position bar appears when there is more to see", (await bar.count()) === 1);
  const bb = await bar.boundingBox();
  await page.mouse.click(bb.x + bb.width * 0.6, bb.y + bb.height / 2);
  await page.waitForTimeout(300);
  const moved = await scroller();
  check("the position bar moves the view", moved.left > 100, `scrolled to ${moved.left}`);

  // The label column is frozen over the lanes, so a clip scrolled underneath
  // it must not show through.
  const covered = await page.evaluate(() => {
    const label = [...document.querySelectorAll("span")].find((e) => e.textContent === "Video");
    const gut = label.closest("div");
    const g = gut.getBoundingClientRect();
    return [0.2, 0.5, 0.8].every((f) => {
      const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height * f);
      return hit && (gut === hit || gut.contains(hit));
    });
  });
  check("the label column stays opaque over a scrolled lane", covered);

  // --- labels stay legible at every magnification -------------------------
  const gapNow = () =>
    page.evaluate(() => {
      const row = document.querySelector('[aria-label="Playhead"]');
      const boxes = [...row.querySelectorAll("span.tnum")]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 0)
        .sort((a, b) => a.left - b.left);
      let min = Infinity;
      for (let i = 1; i < boxes.length; i++) min = Math.min(min, boxes[i].left - boxes[i - 1].right);
      return boxes.length > 1 ? min : 999;
    });
  let worst = Infinity;
  for (let i = 0; i < 12; i++) {
    worst = Math.min(worst, await gapNow());
    const zin = page.getByRole("button", { name: "Show less time" });
    if (await zin.isDisabled()) break;
    await zin.click();
    await page.waitForTimeout(220);
  }
  check("ruler labels keep clear space at every scale", worst >= 6, `${worst.toFixed(1)}px at the worst`);

  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(400);
  const refit = await scroller();
  check("Fit returns the whole edit to the window", refit.w <= refit.view + 2, `${refit.w} in ${refit.view}`);
  const tail = await clipBox();
  const track = await page.getByRole("slider", { name: "Playhead" }).boundingBox();
  check("Fit releases the room a trim held open",
        Math.abs(tail.x + tail.width - (track.x + track.width)) < 8,
        `edit ends ${(track.x + track.width - tail.x - tail.width).toFixed(1)}px from the end of the ruler`);

  // --- the editor refuses a narrow window rather than shrinking into one ---
  await page.setViewportSize({ width: 420, height: 820 });
  await page.waitForTimeout(500);
  check("a phone gets a wall, not a broken editor",
        (await page.getByText("Cutline needs a wider screen").count()) === 1 &&
        (await page.locator("[data-clip]").count()) === 0);

  // The floor is a claim about where the editor works, so check both sides of
  // it rather than only somewhere obviously too small.
  await page.setViewportSize({ width: FLOOR - 24, height: 860 });
  await page.waitForTimeout(500);
  check("just under the floor still gets the wall",
        (await page.locator("[data-clip]").count()) === 0,
        `${FLOOR - 24}px`);
  await page.setViewportSize({ width: FLOOR, height: 860 });
  await page.waitForTimeout(500);
  check("the floor itself gets the editor",
        (await page.locator("[data-clip]").count()) > 0, `${FLOOR}px`);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  check("and the editor comes back with the project intact",
        (await page.locator("[data-clip]").count()) > 0);
}

// ---------------------------------------------------------------------------
log("\n25. Split pieces can be put back in a different order");
{
  const order = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-clip]")]
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map((e) => e.dataset.clip));
  const versions = () => page.getByRole("button", { name: "Restore" }).count();

  const before = await order();
  check("there is more than one clip to reorder", before.length > 1, `${before.length} clips`);

  // Carry the last clip to the front.
  const last = await page.locator("[data-clip]").last().boundingBox();
  const track = await page.getByRole("slider", { name: "Playhead" }).boundingBox();
  const v0 = await versions();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2 - 80, last.y + last.height / 2, { steps: 6 });
  await page.mouse.move(track.x + 10, last.y + last.height / 2, { steps: 18 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = await order();
  check("the carried clip lands at the front", after[0] === before.at(-1),
        `${before.at(-1)?.slice(0, 4)} is now first`);
  check("nothing is lost or duplicated in the move",
        after.length === before.length && new Set(after).size === after.length,
        `${after.length} clips`);
  check("a reorder is exactly one version", (await versions()) - v0 === 1,
        `${(await versions()) - v0} added`);

  // A click is not a drag: selecting must not shuffle the track.
  const settled = await order();
  await page.locator("[data-clip]").nth(1).click();
  await page.waitForTimeout(300);
  check("clicking a clip still only selects it",
        (await order()).join() === settled.join());

  /**
   * Alt+Arrow reorders the selection. It is also the regression guard for a
   * subtler bug: Transport owns a window keydown listener too and is mounted
   * first, so it runs first and moves the playhead. React flushes that
   * synchronously, and while the Timeline's shortcut effect re-registered on
   * every edit that tore its own listener down mid-dispatch — a listener
   * removed during dispatch is never called, so every arrow key reached the
   * transport and stopped there.
   */
  const selected = await page.evaluate(
    () => document.querySelector('[data-clip][style*="1.5px"]')?.dataset.clip ?? null,
  );
  const wasAt = (await order()).indexOf(selected);
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForTimeout(400);
  check("alt and an arrow move the selected clip",
        (await order()).indexOf(selected) === wasAt - 1,
        `position ${wasAt} to ${(await order()).indexOf(selected)}`);

  // And the plain arrow must still belong to the playhead.
  const at = () =>
    page.evaluate(() => {
      const m = /(\d+):(\d\d)\.(\d\d)\s*\//.exec(document.body.innerText);
      return m ? +m[1] * 60 + +m[2] + +m[3] / 100 : -1;
    });
  const t0 = await at();
  const o0 = (await order()).join();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  check("a plain arrow still jogs the playhead", (await at()) > t0, `${t0} to ${await at()}`);
  check("and jogging does not reorder anything", (await order()).join() === o0);
}

// ---------------------------------------------------------------------------
log("\n25b. Emptying the track and bringing it back keeps the timeline's width");
{
  /**
   * An empty track swaps the scroller for a placeholder, so the element the
   * width is measured on unmounts. Measured once on mount, the width then read
   * as 0 forever, and the footage came back drawn 120px wide.
   */
  const clips = () => page.locator("[data-clip]").count();
  const rulerW = async () =>
    (await page.getByRole("slider", { name: "Playhead" }).boundingBox())?.width ?? 0;
  const emptyTrack = async () => {
    for (let guard = 20; (await clips()) > 0 && guard > 0; guard--) {
      await page.locator("[data-clip]").first().click();
      await page.waitForTimeout(200);
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(300);
    }
  };

  const n = await clips();
  const w0 = await rulerW();

  await emptyTrack();
  check("deleting every clip empties the track",
        (await clips()) === 0 && (await page.getByText("Nothing on the timeline").isVisible()));

  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(300);
  check("undo brings every clip back", (await clips()) === n, `${n} to ${await clips()}`);
  const w1 = await rulerW();
  check("and the timeline comes back at its full width", Math.abs(w1 - w0) < 2,
        `${Math.round(w0)}px before, ${Math.round(w1)}px after`);

  // Restore brings the footage back by a different door, through the same
  // remount. The head has no Restore button, so after n deletions the version
  // from before them is button n - 1.
  await emptyTrack();
  await page.getByRole("button", { name: "Restore" }).nth(n - 1).click();
  await page.waitForTimeout(500);
  check("restore brings every clip back", (await clips()) === n, `${n} to ${await clips()}`);
  const w2 = await rulerW();
  check("and so does the timeline's width", Math.abs(w2 - w0) < 2,
        `${Math.round(w0)}px before, ${Math.round(w2)}px after`);
}

// ---------------------------------------------------------------------------
log("\n25c. Nothing on the timeline highlights as text");
{
  const selected = () => page.evaluate(() => window.getSelection()?.toString().trim() ?? "");
  const clear = () => page.evaluate(() => window.getSelection()?.removeAllRanges());

  // A drag that starts on a label and sweeps across the lanes is how text
  // gets painted blue by accident in the middle of an edit.
  await clear();
  const heading = await page.getByRole("heading", { name: "Timeline" }).boundingBox();
  const lastClip = await page.locator("[data-clip]").last().boundingBox();
  await page.mouse.move(heading.x + 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastClip.x + lastClip.width - 4, lastClip.y + lastClip.height + 60, { steps: 12 });
  await page.mouse.up();
  const swept = await selected();
  check("a drag across the timeline selects no text", swept === "", `selected "${swept.slice(0, 40)}"`);

  await clear();
  await page.getByText("Video", { exact: true }).first().dblclick();
  const lane = await selected();
  check("double-clicking a lane name selects nothing", lane === "", `selected "${lane}"`);

  // The transport floats over the timeline card, so it counts as part of it.
  await clear();
  await page.getByText(/^\d+:\d\d\.\d\d$/).first().dblclick();
  const tc = await selected();
  check("double-clicking the timecode selects nothing", tc === "", `selected "${tc}"`);
  await clear();
}

// ---------------------------------------------------------------------------
log("\n25d. A variant can be deleted, after saying what goes with it");
{
  const clips = () => page.locator("[data-clip]").count();
  const deleteButton = () => page.getByRole("button", { name: "Delete this variant" });
  const dialogOpen = () => page.evaluate(() => !!document.querySelector("dialog[open]"));
  // Long on purpose: the name sits in the header chip beside every control.
  const NAME = "short cut for the vertical reel";
  const current = () =>
    page.locator("aside").getByText(new RegExp(`^(main|${NAME})$`)).first().innerText();

  check("there is nothing to delete with only one variant", (await deleteButton().count()) === 0);

  const n0 = await clips();
  await page.getByRole("button", { name: "Variant", exact: true }).click();
  await page.getByPlaceholder("Name this variant").fill(NAME);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  // One version that exists only on the variant.
  await page.locator("[data-clip]").first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);
  check("the variant has its own edit", (await clips()) === n0 - 1, `${n0} to ${await clips()}`);

  // For design review: this puts a fourth control in the rail's header, and
  // below xl the rail is 290px. Measured there, at the narrow end.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(400);
  const rail = await page.locator("aside").boundingBox();
  const header = await page.getByRole("button", { name: "Variant", exact: true }).boundingBox();
  await page.screenshot({
    path: `${OUT}/variant-header.png`,
    clip: { x: rail.x, y: header.y - 12, width: rail.width, height: 110 },
  });
  const del = await deleteButton().boundingBox();
  check("the delete control fits inside the rail",
        del.x >= rail.x && del.x + del.width <= rail.x + rail.width,
        `${Math.round(del.x + del.width - (rail.x + rail.width))}px past the edge`);
  const variantBtn = await page.getByRole("button", { name: "Variant", exact: true }).boundingBox();
  check("and so does the Variant button beside it",
        variantBtn.x >= rail.x && variantBtn.x + variantBtn.width <= del.x,
        `${Math.round(variantBtn.x - rail.x)}px from the rail's edge`);
  // The buttons can fit while the name does not: squeezed, the chip wrapped
  // to three lines and spilled out of the header over the list below.
  const chip = await page.evaluate((name) => {
    const header = [...document.querySelectorAll("aside h2")]
      .find((e) => e.textContent === "Versions")?.parentElement;
    const el = [...(header?.querySelectorAll("span") ?? [])].find((s) => s.textContent === name);
    if (!header || !el) return null;
    const h = header.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    return {
      height: c.height,
      inside: c.top >= h.top && c.bottom <= h.bottom && c.left >= h.left && c.right <= h.right,
    };
  }, NAME);
  check("the variant's name stays on one line, inside the header",
        !!chip && chip.height < 26 && chip.inside,
        chip ? `${Math.round(chip.height)}px tall, ${chip.inside ? "inside" : "spilling out"}` : "chip not found");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  await deleteButton().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/variant-dialog.png` });
  check("deleting asks first", await dialogOpen());
  const says = await page.evaluate(() => document.querySelector("dialog[open]")?.innerText.replace(/\n/g, " ") ?? "");
  check("and names the variant and what goes with it",
        says.includes(NAME) && /1 version/.test(says), says.slice(0, 120));
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  check("focus starts on the safe choice", focused === "Keep it", `focused: ${focused}`);
  const labelled = await page.evaluate(() => {
    const d = document.querySelector("dialog[open]");
    return document.getElementById(d?.getAttribute("aria-labelledby") ?? "")?.closest("dialog") === d;
  });
  check("the dialog is named by its own title, not another dialog's", labelled);

  await page.getByRole("button", { name: "Keep it" }).click();
  await page.waitForTimeout(300);
  check("Keep it leaves the variant alone",
        !(await dialogOpen()) && (await deleteButton().count()) === 1 && (await clips()) === n0 - 1);

  await deleteButton().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Delete variant" }).click();
  await page.waitForTimeout(500);
  check("confirming deletes it and returns to main",
        !(await dialogOpen()) && (await current()) === "main", `on ${await current()}`);
  check("main's edit is on screen", (await clips()) === n0, `${await clips()} clips`);
  check("and with one variant left there is nothing more to delete",
        (await deleteButton().count()) === 0);
}

// ---------------------------------------------------------------------------
log("\n25e. Bring your own key: straight from this browser to the provider");
{
  // Providers are stood in for with page.route, preflight included, so the real path runs on fake keys.
  const GOOD = "sk-ant-api03-e2e-good-key-0123456789";
  const BAD = "sk-ant-api03-e2e-bad-key-0123456789";
  const OPENAI = "sk-proj-e2e-openai-key-0123456789";
  const KEYS = [GOOD, BAD, OPENAI];

  const seen = [];
  const onRequest = (r) => seen.push({ url: r.url(), headers: r.headers(), body: r.postData() ?? "" });
  page.on("request", onRequest);

  const caps = {
    thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
    effort: {
      supported: true, low: { supported: true }, medium: { supported: true },
      high: { supported: true }, max: { supported: true }, xhigh: { supported: true },
    },
  };
  const anthropicModels = [
    { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-05-01T00:00:00Z", capabilities: caps },
    { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z", capabilities: null },
  ];
  const claude = (content, stop_reason, model = "claude-opus-5") => ({
    id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model,
    content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
  });
  const gpt = (message, finish_reason) => ({
    id: "chatcmpl-e2e", object: "chat.completion", created: 1, model: "gpt-5",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
  });

  const script = { anthropic: [], openai: [] };
  const sent = { anthropic: [], openai: [] };
  const cors = (req) => ({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": req.headers()["access-control-request-headers"] ?? "*",
    "content-type": "application/json",
  });
  const answer = async (route, provider) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(req) }).catch(() => {});
    // A stopped request is abandoned by the page; answering it late must not throw.
    const reply = (status, json) =>
      route.fulfill({ status, headers: cors(req), body: JSON.stringify(json) }).catch(() => {});
    if (new URL(req.url()).pathname.endsWith("/models")) {
      if (provider === "openai") {
        return reply(200, { object: "list", data: [
          { id: "gpt-5", object: "model", created: 2 },
          { id: "text-embedding-3-large", object: "model", created: 3 },
        ] });
      }
      if (req.headers()["x-api-key"] !== GOOD) {
        return reply(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      }
      return reply(200, { data: anthropicModels, has_more: false, first_id: "claude-opus-5", last_id: "claude-haiku-4-5" });
    }
    sent[provider].push({ headers: req.headers(), body: JSON.parse(req.postData() || "{}") });
    const next = script[provider].shift() ?? {
      body: provider === "openai" ? gpt({ content: "Done." }, "stop") : claude([{ type: "text", text: "Done." }], "end_turn"),
    };
    if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
    return reply(200, next.body);
  };
  await page.route("https://api.anthropic.com/**", (r) => answer(r, "anthropic"));
  await page.route("https://api.openai.com/**", (r) => answer(r, "openai"));

  const aside = page.locator("aside");
  const keyInput = () => aside.getByLabel("API key");
  const connectBtn = () => aside.getByRole("button", { name: /^Connect( to|$)/ });
  const composer = () => aside.getByRole("textbox", { name: "Ask for an edit" });
  const modelButton = () => aside.getByRole("button", { name: /^Model: / });
  const versions = () => page.getByRole("button", { name: "Restore" }).count();
  const total = () =>
    page.evaluate(() => {
      const m = /\/\s*(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
      return m ? +m[1] * 60 + +m[2] + +m[3] / 100 : -1;
    });
  const askFor = async (text) => {
    await composer().fill(text);
    await composer().press("Enter");
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !document.querySelector('aside [aria-label="Stop"]'), null, { timeout: 15000 });
    await page.waitForTimeout(200);
  };
  const stored = () =>
    page.evaluate(() => ({ local: !!localStorage.getItem("cutline.ai"), session: !!sessionStorage.getItem("cutline.ai") }));
  // Everything in the rail stays inside it — measured at the floor, where it is 290px.
  const railSpill = () =>
    page.evaluate(() => {
      const a = document.querySelector("aside").getBoundingClientRect();
      let worst = 0;
      for (const el of document.querySelectorAll("aside button, aside input, aside label, aside p, aside a")) {
        if (el.closest(".overflow-y-auto")) continue;
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        worst = Math.max(worst, b.right - a.right, a.left - b.left);
      }
      return Math.round(worst);
    });

  // --- no key yet ---
  check("with no key, the Ask panel asks for one", await keyInput().isVisible());
  check("the suggestions wait for a model",
        await aside.getByRole("button", { name: "Cut all the silences" }).isDisabled());
  check("and Connect appears only once there is a key to connect", (await connectBtn().count()) === 0);

  await page.setViewportSize({ width: FLOOR, height: 900 });
  await page.waitForTimeout(400);
  check("the key card fits the rail at the floor", (await railSpill()) <= 1, `${await railSpill()}px past the rail`);
  await aside.screenshot({ path: `${OUT}/byok-card.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // --- a key that is refused ---
  await keyInput().fill(BAD);
  await page.waitForTimeout(250);
  check("the provider is recognised as the key is pasted",
        (await aside.getByText("Anthropic", { exact: true }).count()) === 1 &&
        (await connectBtn().innerText()).includes("Connect to Anthropic"),
        await connectBtn().innerText());
  // The card with its button, at the floor, where the rail is tightest.
  await page.setViewportSize({ width: FLOOR, height: 900 });
  await page.waitForTimeout(400);
  check("with a key in, the card still fits the rail", (await railSpill()) <= 1, `${await railSpill()}px past the rail`);
  await aside.screenshot({ path: `${OUT}/byok-card-key.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await connectBtn().click();
  const refused = aside.getByText("Anthropic didn't accept this key.");
  await refused.waitFor({ timeout: 8000 }).catch(() => {});
  check("a refused key says so, and how to fix it",
        (await refused.isVisible()) && (await aside.getByText(/copied whole/).isVisible()));

  // --- a key that works ---
  await keyInput().fill(GOOD);
  await connectBtn().click();
  await composer().waitFor({ timeout: 8000 }).catch(() => {});
  check("a good key connects, and the composer takes the card's place", await composer().isVisible());
  check("the best model is chosen without asking",
        (await modelButton().innerText().catch(() => "")).includes("claude-opus-5"));

  // One line, and the nested button's corner is the field's radius less the inset.
  const field = await page.evaluate(() => {
    const input = document.querySelector('aside input[aria-label="Ask for an edit"]');
    const box = input?.parentElement;
    const send = box?.querySelector("button");
    if (!input || !box || !send) return null;
    return {
      tag: input.tagName,
      height: box.getBoundingClientRect().height,
      outer: parseFloat(getComputedStyle(box).borderTopRightRadius),
      inner: parseFloat(getComputedStyle(send).borderTopRightRadius),
      inset: send.getBoundingClientRect().top - box.getBoundingClientRect().top,
    };
  });
  check("the composer is a single line", field?.tag === "INPUT" && field.height <= 40,
        field ? `${field.tag.toLowerCase()}, ${Math.round(field.height)}px tall` : "not found");
  check("its button's corner is concentric with the field's",
        !!field && Math.abs(field.outer - field.inset - field.inner) <= 0.5,
        field ? `${field.outer}px field less ${field.inset}px inset against a ${field.inner}px button` : "");

  // --- an edit, end to end ---
  const t0 = await total();
  const v0 = await versions();
  script.anthropic.push(
    { body: claude([
      { type: "thinking", thinking: "", signature: "sig-e2e" },
      { type: "tool_use", id: "toolu_e2e", name: "ripple_delete", input: { start: 0, end: 1 } },
    ], "tool_use") },
    { body: claude([{ type: "text", text: "Dropped the first second." }], "end_turn") },
  );
  await askFor("Drop the first second");
  check("the agent's edit lands", Math.abs(t0 - (await total()) - 1) < 0.05, `${t0}s to ${await total()}s`);
  check("as one version, named for what was asked",
        (await versions()) - v0 === 1 && (await page.getByText("Drop the first second", { exact: true }).count()) >= 2);
  check("its step and its reply are shown",
        (await aside.getByText("Cut 0:00.00–0:01.00").isVisible()) &&
        (await aside.getByText("Dropped the first second.").isVisible()));

  const [first, second] = sent.anthropic.slice(-2);
  check("the request goes straight to Anthropic, marked as coming from a browser",
        first?.headers["x-api-key"] === GOOD && first?.headers["anthropic-dangerous-direct-browser-access"] === "true");
  check("Opus 5 thinks adaptively, at high effort, with refusal fallbacks",
        first?.body.thinking?.type === "adaptive" && first?.body.output_config?.effort === "high" &&
        first?.body.fallbacks === "default" &&
        (first?.headers["anthropic-beta"] ?? "").includes("server-side-fallback-2026-07-01"));
  const told = JSON.stringify(first?.body.messages.at(-1)?.content ?? "");
  check("the model is told where the playhead is and what changed last",
        told.includes("Playhead:") && told.includes("Last change:"));
  const echoed = second?.body.messages.at(-2)?.content ?? [];
  const results = second?.body.messages.at(-1)?.content ?? [];
  check("its thinking travels back verbatim, and the result answers the call by id",
        Array.isArray(echoed) && echoed.some((b) => b.type === "thinking" && b.signature === "sig-e2e") &&
        Array.isArray(results) && results.some((b) => b.type === "tool_result" && b.tool_use_id === "toolu_e2e"));

  // --- a follow-up ---
  script.anthropic.push({ body: claude([{ type: "text", text: "Nothing more to take out." }], "end_turn") });
  const v1 = await versions();
  await askFor("A bit more");
  const follow = sent.anthropic.at(-1)?.body.messages ?? [];
  check("a follow-up carries the earlier exchange",
        follow[0]?.content === "Drop the first second" && String(follow.at(-1)?.content).includes("Request: A bit more"));
  check("a reply with no edit adds no version", (await versions()) === v1);

  // --- stopping ---
  script.anthropic.push({ delay: 5000, body: claude([
    { type: "tool_use", id: "toolu_late", name: "ripple_delete", input: { start: 0, end: 5 } },
  ], "tool_use") });
  const v2 = await versions();
  const t2 = await total();
  await composer().fill("Trim the start");
  await composer().press("Enter");
  const stopBtn = aside.getByRole("button", { name: "Stop" });
  await stopBtn.waitFor({ timeout: 3000 }).catch(() => {});
  check("while it works, Send becomes Stop", await stopBtn.isVisible());
  await stopBtn.click();
  await page.waitForTimeout(500);
  check("stopping changes nothing, and says so",
        (await versions()) === v2 && Math.abs((await total()) - t2) < 0.01 &&
        (await aside.getByText("Stopped. Nothing was changed.").isVisible()));

  // --- another model, in the modal ---
  const modal = page.getByRole("dialog", { name: "Model and key" });
  await modelButton().click();
  await modal.waitFor({ timeout: 3000 }).catch(() => {});
  check("the model and key open in a modal", await modal.isVisible());
  const placed = await page.evaluate(() => {
    const d = [...document.querySelectorAll("dialog[open]")].pop()?.getBoundingClientRect();
    if (!d) return null;
    return {
      dx: Math.abs(d.left + d.width / 2 - innerWidth / 2) / innerWidth,
      dy: Math.abs(d.top + d.height / 2 - innerHeight / 2) / innerHeight,
    };
  });
  check("centred on the window", !!placed && placed.dx < 0.06 && placed.dy < 0.06,
        placed ? `off by ${(placed.dx * 100).toFixed(1)}% / ${(placed.dy * 100).toFixed(1)}%` : "not open");
  check("with the search focused, ready to type",
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search models"));
  check("the model in use is marked", (await modal.getByRole("option", { selected: true }).innerText()).includes("claude-opus-5"));
  const picker = modal.getByRole("combobox");
  await picker.fill("haiku");
  await page.waitForTimeout(200);
  check("the model list filters as you type", (await modal.getByRole("option").count()) === 1);
  await picker.press("Enter");
  await page.waitForTimeout(300);
  check("choosing a model switches to it and closes the modal",
        !(await modal.isVisible()) && (await modelButton().innerText()).includes("claude-haiku-4-5"));

  // At the floor: the modal fits the window, and Escape backs out of it.
  await page.setViewportSize({ width: FLOOR, height: 900 });
  await page.waitForTimeout(400);
  await modelButton().click();
  await modal.waitFor({ timeout: 3000 }).catch(() => {});
  const fits = await page.evaluate(() => {
    const d = [...document.querySelectorAll("dialog[open]")].pop()?.getBoundingClientRect();
    return !!d && d.left >= 16 && d.right <= innerWidth - 16 && d.top >= 16 && d.bottom <= innerHeight - 16;
  });
  check("the modal fits the window at the floor", fits);
  // After its .18s entrance: a capture mid-fade shows the page through it.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/byok-modal.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes it without changing the model",
        !(await modal.isVisible()) && (await modelButton().innerText()).includes("claude-haiku-4-5"));
  await aside.screenshot({ path: `${OUT}/byok-composer.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  script.anthropic.push({ body: claude([{ type: "text", text: "Done." }], "end_turn", "claude-haiku-4-5") });
  await askFor("Anything else?");
  const h = sent.anthropic.at(-1)?.body ?? {};
  check("a model that cannot think is not asked to",
        h.model === "claude-haiku-4-5" && !("thinking" in h) && !("output_config" in h) && !("fallbacks" in h));

  // --- where the key lives ---
  check("it is remembered on this device by default", (await stored()).local);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("so a reload keeps the connection", await modelButton().isVisible().catch(() => false));
  await modelButton().click();
  await modal.getByRole("checkbox", { name: "Remember on this device" }).uncheck();
  const tabOnly = await stored();
  check("unticking keeps it for this tab alone", !tabOnly.local && tabOnly.session);
  const project = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("cutline");
        open.onerror = () => resolve("");
        open.onsuccess = () => {
          const get = open.result.transaction("project").objectStore("project").get("current");
          get.onsuccess = () => resolve(JSON.stringify(get.result ?? ""));
          get.onerror = () => resolve("");
        };
      }),
  );
  check("the key is never saved with the project", project.length > 0 && KEYS.every((k) => !project.includes(k)));
  await modal.getByRole("button", { name: "Forget key" }).click();
  await page.waitForTimeout(300);
  const gone = await stored();
  check("forgetting removes it everywhere and asks for a key again",
        !gone.local && !gone.session && (await keyInput().isVisible()));

  // --- a key that could be either ---
  await keyInput().fill("sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4");
  await page.waitForTimeout(250);
  const which = aside.getByRole("group", { name: "Provider" });
  check("a look-alike key asks which provider issued it",
        (await which.isVisible()) && (await connectBtn().innerText()).includes("OpenAI"));
  await which.getByRole("button", { name: "DeepSeek" }).click();
  check("and connects where it is told, never where it guesses",
        (await connectBtn().innerText()).includes("DeepSeek"));

  // --- the other wire ---
  await keyInput().fill(OPENAI);
  await connectBtn().click();
  await composer().waitFor({ timeout: 8000 }).catch(() => {});
  check("an OpenAI key connects to its best chat model",
        (await modelButton().innerText().catch(() => "")).includes("gpt-5"));
  script.openai.push(
    { body: gpt({ content: null, tool_calls: [{ id: "call_e2e", type: "function", function: {
      name: "add_fade", arguments: JSON.stringify({ at: 0, dur: 1, mode: "in" }),
    } }] }, "tool_calls") },
    { body: gpt({ content: "Faded in the opening." }, "stop") },
  );
  const v3 = await versions();
  await askFor("Fade in the opening");
  const [o1, o2] = sent.openai.slice(-2);
  check("the same edit works over the OpenAI wire",
        (await versions()) - v3 === 1 && (await aside.getByText("Faded in the opening.").isVisible()));
  check("tools go as functions, and results come back by call id",
        o1?.body.tools?.[0]?.type === "function" && o1?.headers.authorization === `Bearer ${OPENAI}` &&
        (o2?.body.messages ?? []).some((m) => m.role === "tool" && m.tool_call_id === "call_e2e"));

  // --- nothing leaks ---
  const leaks = seen.filter(
    (r) =>
      !/^https:\/\/api\.(anthropic|openai)\.com\//.test(r.url) &&
      KEYS.some((k) => r.url.includes(k) || r.body.includes(k) || Object.values(r.headers).some((v) => String(v).includes(k))),
  );
  check("no key is ever sent anywhere but its provider", leaks.length === 0, leaks.map((r) => r.url).join(", "));
  const crossed = seen.filter(
    (r) =>
      (r.url.startsWith("https://api.openai.com/") && JSON.stringify(r).includes("sk-ant-")) ||
      (r.url.startsWith("https://api.anthropic.com/") && JSON.stringify(r).includes(OPENAI)),
  );
  check("and never to the other provider", crossed.length === 0);

  await modelButton().click();
  await modal.getByRole("button", { name: "Forget key" }).click();
  page.off("request", onRequest);
  await page.unroute("https://api.anthropic.com/**");
  await page.unroute("https://api.openai.com/**");
}

// ---------------------------------------------------------------------------
log("\n25f. Ask and Versions fold, together or apart");
{
  const heading = (name) => page.getByRole("button", { name, exact: true });
  const isOpen = async (name) => (await heading(name).getAttribute("aria-expanded")) === "true";
  const height = (name) =>
    page.evaluate((n) => {
      const h = [...document.querySelectorAll("aside h2")].find((e) => e.textContent === n);
      return Math.round(h?.parentElement?.parentElement?.getBoundingClientRect().height ?? -1);
    }, name);
  const keyInput = () => page.locator("aside").getByLabel("API key");

  check("both start open", (await isOpen("Ask")) && (await isOpen("Versions")));

  const versions0 = await height("Versions");
  await heading("Ask").click();
  await page.waitForTimeout(300);
  check("folding Ask leaves just its heading", (await height("Ask")) <= 42, `${await height("Ask")}px`);
  check("and gives its room to Versions", (await height("Versions")) > versions0 + 100,
        `${versions0}px to ${await height("Versions")}px`);
  check("the fold is announced to assistive tech", !(await isOpen("Ask")));
  await page.locator("aside").screenshot({ path: `${OUT}/rail-folded.png` });

  await heading("Ask").click();
  await page.waitForTimeout(300);
  check("unfolding Ask brings its contents back", (await isOpen("Ask")) && (await keyInput().isVisible()));

  await heading("Versions").click();
  await page.waitForTimeout(300);
  check("folding Versions leaves just its heading", (await height("Versions")) <= 42, `${await height("Versions")}px`);
  check("while Ask keeps working above it", await keyInput().isVisible());

  await heading("Ask").click();
  await page.waitForTimeout(300);
  check("both can fold at once", (await height("Ask")) <= 42 && (await height("Versions")) <= 42);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("the folds are remembered across a reload", !(await isOpen("Ask")) && !(await isOpen("Versions")));

  await heading("Ask").click();
  await heading("Versions").click();
  await page.waitForTimeout(300);
  check("and both unfold again", (await isOpen("Ask")) && (await isOpen("Versions")) && (await keyInput().isVisible()));

  // The remember box: a real checkbox, reached by Tab, toggled by Space, with a ring and a 32px target.
  await keyInput().click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  const box = await page.evaluate(() => {
    const input = document.querySelector('aside form input[type="checkbox"]');
    const face = input?.nextElementSibling;
    return {
      focused: document.activeElement === input,
      checked: input?.checked,
      ring: face ? getComputedStyle(face).outlineStyle : "none",
      target: Math.round(input?.closest("label")?.getBoundingClientRect().height ?? 0),
    };
  });
  check("the remember box is reached by Tab and toggled by Space", box.focused && box.checked === false,
        `focused ${box.focused}, checked ${box.checked}`);
  check("and shows where keyboard focus is", box.ring === "solid", `outline ${box.ring}`);
  check("its target is at least 32px tall", box.target >= 32, `${box.target}px`);
  await page.locator('aside form[aria-label="Connect a model"]').screenshot({ path: `${OUT}/checkbox-focus.png` });
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  await page.locator('aside form[aria-label="Connect a model"]').screenshot({ path: `${OUT}/checkbox-on.png` });
}

// ---------------------------------------------------------------------------
log("\n25g. A sound lane, and the original audio muted");
{
  // Every media element that has been told to play, so playback can be checked on the real elements.
  await page.evaluate(() => {
    if (window.__media) return;
    window.__media = new Set();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__media.add(this);
      return play.call(this);
    };
  });
  const audioPlaying = () =>
    page.evaluate(() => [...window.__media].some((m) => m instanceof HTMLAudioElement && !m.paused));
  const videos = () =>
    page.evaluate(() => [...window.__media].filter((m) => m instanceof HTMLVideoElement && !m.paused).map((m) => m.muted));

  // A real four-second tone, recorded in the page, so the file goes through the real import.
  const tone = await page.evaluate(async () => {
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = 330;
    gain.gain.value = 0.3;
    osc.connect(gain).connect(dest);
    osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: "audio/webm;codecs=opus" });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start();
    await new Promise((r) => setTimeout(r, 4000));
    await new Promise((r) => {
      rec.onstop = r;
      rec.stop();
    });
    osc.stop();
    await ac.close();
    const bytes = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  });

  await page.keyboard.press("Home");
  await page.locator('input[aria-label="Add a sound"]').setInputFiles({
    name: "tone.webm", mimeType: "audio/webm", buffer: Buffer.from(tone, "base64"),
  });
  const item = page.locator("[data-sound]").first();
  await item.waitFor({ timeout: 15000 }).catch(() => {});
  check("adding a sound makes a Sound lane with the sound on it",
        (await page.locator("[data-sound]").count()) === 1 && (await page.getByText("Sound", { exact: true }).first().isVisible()));
  check("as one version, named for the file", (await page.getByText("Add sound tone.webm", { exact: true }).count()) === 1);
  check("the new sound is selected, with its volume in the inspector",
        await page.getByRole("slider", { name: /Volume/ }).first().isVisible().catch(() => false));
  await page.locator("[data-sound]").first().locator("xpath=ancestor::div[contains(@class,'rounded-panel')][1]")
    .screenshot({ path: `${OUT}/sound-lane.png` }).catch(() => {});

  // --- drag the body to move it, and its head to trim into the file ---
  const s0 = await item.boundingBox();
  await page.mouse.move(s0.x + s0.width / 2, s0.y + s0.height / 2);
  await page.mouse.down();
  await page.mouse.move(s0.x + s0.width / 2 + 60, s0.y + s0.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const s1 = await item.boundingBox();
  check("dragging the sound moves it", s1.x > s0.x + 40 && Math.abs(s1.width - s0.width) < 2,
        `moved ${(s1.x - s0.x).toFixed(1)}px`);
  check("as a version", (await page.getByText("Move sound", { exact: true }).count()) === 1);

  await page.mouse.move(s1.x + 3, s1.y + s1.height / 2);
  await page.mouse.down();
  await page.mouse.move(s1.x + 35, s1.y + s1.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const s2 = await item.boundingBox();
  check("trimming its head moves the start and keeps the end",
        s2.x > s1.x + 20 && Math.abs(s2.x + s2.width - (s1.x + s1.width)) < 2,
        `start moved ${(s2.x - s1.x).toFixed(1)}px, end moved ${(s2.x + s2.width - s1.x - s1.width).toFixed(1)}px`);

  // --- it plays over the picture ---
  const ruler = await page.getByRole("slider", { name: "Playhead" }).boundingBox();
  await page.mouse.click(s2.x + Math.min(12, s2.width / 3), ruler.y + ruler.height / 2);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(700);
  const heard = await audioPlaying();
  await page.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
  await page.waitForTimeout(300);
  check("the sound plays when the playhead crosses it", heard);
  check("and stops with the picture", !(await audioPlaying()));

  // --- lanes catch on the edit's landmarks, so tracks line up ---
  {
    const clipBox = await page.locator("[data-clip]").first().boundingBox();
    const cut = clipBox.x + clipBox.width;
    const from = await item.boundingBox();
    const grab = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    // Aim 4px short of the cut: inside the 7px catch, far outside one frame.
    const pointerStops = cut - 4;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + (pointerStops - from.x), grab.y, { steps: 12 });
    await page.waitForTimeout(150);
    const guide = page.locator("[data-snap]");
    const caught = (await guide.count()) === 1 ? (await guide.first().boundingBox()).x : null;
    await page.mouse.up();
    await page.waitForTimeout(400);
    const landed = await item.boundingBox();
    check("a guide marks the landmark a drag has caught", caught !== null);
    // Either edge may be the one that catches, so the item is checked against
    // the line it actually caught, not against the cut we aimed at.
    check("and the item lands on that line, not where the pointer stopped",
          caught !== null && Math.abs(landed.x - caught) < 1.5 && Math.abs(landed.x - pointerStops) > 1,
          caught === null ? "nothing caught"
            : `${(landed.x - caught).toFixed(2)}px from the line, ${(landed.x - pointerStops).toFixed(2)}px from the pointer`);
  }

  // --- the original audio, muted and back ---
  await page.getByRole("button", { name: "Mute original audio" }).click();
  await page.waitForTimeout(300);
  check("muting the original audio is a pressed toggle and a version",
        (await page.getByRole("button", { name: "Unmute original audio" }).getAttribute("aria-pressed")) === "true" &&
        (await page.getByText("Mute original audio", { exact: true }).count()) === 1);
  const firstClip = await page.locator("[data-clip]").first().boundingBox();
  await page.mouse.click(firstClip.x + 8, ruler.y + ruler.height / 2);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(600);
  const whileMuted = await videos();
  await page.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
  await page.waitForTimeout(300);
  check("while muted, the video plays silent", whileMuted.length > 0 && whileMuted.every(Boolean),
        `${whileMuted.length} playing, muted: ${whileMuted.join(",")}`);

  await page.getByRole("button", { name: "Unmute original audio" }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(600);
  const afterUnmute = await videos();
  await page.getByRole("button", { name: "Pause", exact: true }).click().catch(() => {});
  await page.waitForTimeout(300);
  check("unmuting brings the video's sound back", afterUnmute.length > 0 && afterUnmute.every((m) => !m),
        `muted: ${afterUnmute.join(",")}`);

  // --- and it goes the way a fade does ---
  await item.click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(400);
  check("Backspace removes the selected sound and leaves its lane",
        (await page.locator("[data-sound]").count()) === 0 && (await page.getByText("Sound", { exact: true }).first().isVisible()));
}

// ---------------------------------------------------------------------------
log("\n26. Export writes a real file, in this browser");
{
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.waitForTimeout(500);
  const offered = await page.evaluate(() => document.querySelector("dialog[open]")?.innerText ?? "");
  check("the dialog states the picture it will write", /\d+ × \d+ at \d+ fps/.test(offered),
        offered.replace(/\n/g, " ").slice(0, 80));
  check("and the container, decided by what this browser can encode", /MP4|WEBM/.test(offered));

  // The file arrives as a real download, the same way a user gets it.
  const saved = page.waitForEvent("download", { timeout: 240000 });
  await page.getByRole("button", { name: "Export video" }).click();
  await page.waitForSelector("text=is ready", { timeout: 240000 });
  check("the export runs to completion", true);

  await page.getByRole("button", { name: "Save video" }).click();
  const download = await saved;
  const bytes = fs.readFileSync(await download.path());
  check("the saved file is named after the footage",
        /-cutline\.(mp4|webm)$/.test(download.suggestedFilename()), download.suggestedFilename());
  check("and holds real encoded bytes", bytes.length > 20000, `${(bytes.length / 1024).toFixed(0)}KB`);

  const mp4 = bytes.subarray(4, 8).toString("latin1") === "ftyp";
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  check("that a player recognises as video", mp4 || webm,
        mp4 ? "MP4" : webm ? "WebM" : bytes.subarray(0, 8).toString("hex"));

  // Decode it back: a file that will not play is not an export.
  const played = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([buf]));
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    const ok = await new Promise((resolve) => {
      v.onloadedmetadata = () => resolve(true);
      v.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 15000);
    });
    const out = { ok, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
    URL.revokeObjectURL(url);
    return out;
  }, bytes.toString("base64"));
  check("the exported file plays back", played.ok && played.width > 0,
        `${played.width}x${played.height}, ${played.duration?.toFixed?.(2)}s`);
  check("at the size the dialog promised",
        offered.includes(`${played.width} × ${played.height}`), `${played.width} × ${played.height}`);
  check("and carries the whole edit", played.duration > 0.5 && Number.isFinite(played.duration),
        `${played.duration?.toFixed?.(2)}s`);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForTimeout(300);
  check("closing puts the editor back", !(await page.evaluate(() => !!document.querySelector("dialog[open]"))));
}

// ---------------------------------------------------------------------------
log("\n27. New project asks before destroying the work");
{
  const editorOpen = () => page.evaluate(() => document.body.innerText.includes("Timeline"));
  const dialogOpen = () => page.evaluate(() => !!document.querySelector("dialog[open]"));

  await page.getByRole("button", { name: /New project/ }).click();
  await page.waitForTimeout(400);

  check("a confirmation appears", await dialogOpen());

  // Preflight resets the margin a modal <dialog> centres itself with, so the
  // position has to be asserted rather than assumed.
  const placement = await page.evaluate(() => {
    const d = document.querySelector("dialog[open]").getBoundingClientRect();
    return {
      dx: Math.abs((d.left + d.width / 2) - window.innerWidth / 2) / window.innerWidth,
      dy: Math.abs((d.top + d.height / 2) - window.innerHeight / 2) / window.innerHeight,
    };
  });
  check("the dialog is centred", placement.dx < 0.06 && placement.dy < 0.06,
        `off-centre by ${(placement.dx * 100).toFixed(1)}% / ${(placement.dy * 100).toFixed(1)}%`);
  check("the project is untouched until confirmed", await editorOpen());
  check("it says what is at stake, not just 'are you sure'",
        await page.evaluate(() => /\d+ versions?/.test(document.querySelector("dialog")?.innerText ?? "")),
        (await page.evaluate(() => document.querySelector("dialog")?.innerText.replace(/\n/g, " ").slice(0, 90))));

  // The safe choice takes focus: a destructive action must not be one stray
  // Enter away.
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  check("focus starts on the safe choice", focused === "Keep editing", `focused: ${focused}`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("Escape cancels", !(await dialogOpen()) && (await editorOpen()));

  await page.getByRole("button", { name: /New project/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Keep editing" }).click();
  await page.waitForTimeout(400);
  check("Keep editing cancels", !(await dialogOpen()) && (await editorOpen()));

  // The footage lives in OPFS, not in the project record, so clearing the
  // record alone leaves every imported file behind, eating the quota.
  const storedFiles = () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      const dir = await root.getDirectoryHandle("media");
      let n = 0;
      for await (const _ of dir.keys()) n++;
      return n;
    } catch {
      return 0;
    }
  });
  const before = await storedFiles();

  await page.getByRole("button", { name: /New project/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Delete and start over" }).click();
  await page.waitForTimeout(900);
  check("confirming clears the project", !(await editorOpen()));
  check("and returns to the import screen",
        await page.getByText(/Drop a video/).isVisible());
  const after = await storedFiles();
  check("and deletes the imported footage from disk", before > 0 && after === 0,
        `${before} file(s) stored before, ${after} after`);
}

log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures ? 1 : 0);
