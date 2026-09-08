import { chromium } from "playwright-core";

const OUT = process.env.SHOT_DIR ?? "/tmp";
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

  check("labels are clear at 1x", (await overlaps()) === 0);

  await page.getByRole("button", { name: "0.5×", exact: true }).click();
  await page.waitForTimeout(500);
  check("labels stay clear at 0.5x", (await overlaps()) === 0, "half speed doubles the timeline");

  await page.getByRole("button", { name: "2×", exact: true }).click();
  await page.waitForTimeout(500);
  check("labels stay clear at 2x", (await overlaps()) === 0);

  // Narrow windows are where labels actually collide: the ruler loses width
  // while the number of ticks stays the same.
  await page.setViewportSize({ width: 820, height: 720 });
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

  await page.mouse.click(lane.x + lane.width * 0.92, lane.y + lane.height / 2);
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
log("\n20. Trimming a clip by dragging its edge");
{
  const total = () =>
    page.evaluate(() => {
      const m = /(\d+):(\d\d)\.(\d\d)\s*\/\s*(\d+):(\d\d)\.(\d\d)/.exec(document.body.innerText);
      return m ? +m[4] * 60 + +m[5] + +m[6] / 100 : -1;
    });
  const clipBox = () => page.locator("[data-clip]").first().boundingBox();

  const before = await total();
  const c0 = await clipBox();
  // Drag the head of the first clip inward.
  await page.mouse.move(c0.x + 3, c0.y + c0.height / 2);
  await page.mouse.down();
  await page.mouse.move(c0.x + 110, c0.y + c0.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = await total();
  check("trimming the head shortens the timeline", after < before - 0.3,
        `${before.toFixed(2)}s to ${after.toFixed(2)}s`);
  check("the trim is one version", (await page.getByText("Trim clip").count()) > 0);

  // The tail must move independently of the head.
  const c1 = await clipBox();
  const startBefore = c1.x;
  await page.mouse.move(c1.x + c1.width - 3, c1.y + c1.height / 2);
  await page.mouse.down();
  await page.mouse.move(c1.x + c1.width - 90, c1.y + c1.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const c2 = await clipBox();
  check("trimming the tail leaves the head where it was", Math.abs(c2.x - startBefore) < 2,
        `moved ${(c2.x - startBefore).toFixed(1)}px`);
  check("trimming the tail shortens it further", (await total()) < after,
        `${after.toFixed(2)}s to ${(await total()).toFixed(2)}s`);
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

  for (const w of [1680, 1440, 1200, 1024, 900]) {
    const n = await stolenAt(w);
    check(`no clicks stolen at ${w}px`, n === 0, n < 0 ? "transport not found" : `${n} stolen`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
log("\n24. New project asks before destroying the work");
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

  await page.getByRole("button", { name: /New project/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Delete and start over" }).click();
  await page.waitForTimeout(900);
  check("confirming clears the project", !(await editorOpen()));
  check("and returns to the import screen",
        await page.getByText(/Drop a video/).isVisible());
}

log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures ? 1 : 0);
