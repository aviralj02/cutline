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
await page.waitForSelector("text=TIMELINE", { timeout: 45000 });
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
const track = page.locator(".cursor-ew-resize");
const box = await track.boundingBox();
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Split at playhead" }).click();
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
const survived = await page.evaluate(() => document.body.innerText.includes("TIMELINE"));
check("project survived a reload", survived);
await page.screenshot({ path: `${OUT}/03-reloaded.png` });

log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures ? 1 : 0);
