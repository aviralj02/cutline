import { chromium } from "playwright-core";
const OUT = process.env.SHOT_DIR ?? "/tmp";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/ui-start.png` });

// Same synthetic clip the verification suite uses.
await page.evaluate(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext("2d");
  const ac = new AudioContext(); const dest = ac.createMediaStreamDestination();
  const osc = ac.createOscillator(); const gain = ac.createGain();
  osc.type = "sawtooth"; osc.frequency.value = 200; osc.connect(gain).connect(dest);
  gain.gain.setValueAtTime(0.35, ac.currentTime);
  gain.gain.setValueAtTime(0.0, ac.currentTime + 5);
  gain.gain.setValueAtTime(0.35, ac.currentTime + 8);
  gain.gain.setValueAtTime(0.0, ac.currentTime + 13);
  gain.gain.setValueAtTime(0.35, ac.currentTime + 16);
  osc.start();
  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data); rec.start();
  const t0 = performance.now();
  await new Promise((resolve) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const g = ctx.createLinearGradient(0, 0, 1280, 720);
      g.addColorStop(0, `hsl(${(t * 14) % 360} 30% 26%)`);
      g.addColorStop(1, `hsl(${(t * 14 + 40) % 360} 34% 14%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.font = "600 84px system-ui"; ctx.textAlign = "center";
      ctx.fillText(t.toFixed(1) + "s", 640, 390);
      if (t >= 20) resolve(); else requestAnimationFrame(draw);
    }; draw();
  });
  rec.stop(); osc.stop(); await new Promise((r) => (rec.onstop = r));
  const file = new File([new Blob(chunks, { type: "video/webm" })], "interview-take-2.webm", { type: "video/webm" });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.querySelector('input[type="file"]');
  input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForSelector("text=Timeline", { timeout: 45000 });
await page.waitForTimeout(2500);

// Put the playhead mid-clip and select a clip so the editor looks in use.
// The ruler by name, not by cursor class: trim handles carry that class too.
const ruler = page.getByRole("slider", { name: "Playhead" });
const box = await ruler.boundingBox();
await page.mouse.click(box.x + box.width * 0.42, box.y + box.height / 2);
await page.waitForTimeout(300);
await page.locator("[data-clip]").first().click();
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^Split/ }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/ui-editor.png` });

// The one place an edit becomes a file.
await page.getByRole("button", { name: "Export", exact: true }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/ui-export.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Crop mode, with a preset applied so the handles sit on a real framing.
await page.getByRole("button", { name: "Crop" }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "9:16" }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/ui-crop.png` });
await page.getByRole("button", { name: "Reset" }).click();
await page.getByRole("button", { name: "Done" }).click();
await page.waitForTimeout(400);

// Narrow viewport, to see what the composition does when squeezed.
await page.setViewportSize({ width: 900, height: 700 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/ui-narrow.png` });

console.log("shots written");
await browser.close();
