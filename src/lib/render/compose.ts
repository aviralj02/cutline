import type { Crop, Edl, Sec } from "../edl/types";
import { fadeAt, zoomAt } from "../edl/query";

/**
 * One frame of the edit, drawn onto a 2D context. Preview calls this every
 * animation frame and the exporter calls it for every frame of the file, so
 * what you see is what is written — there is no second copy of this maths to
 * drift from.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A decoded picture to draw, with its own pixel size. */
export interface Picture {
  source: CanvasImageSource;
  width: number;
  height: number;
}

function drawText(ctx: Ctx, edl: Edl, t: Sec, w: number, h: number) {
  for (const item of edl.text) {
    if (t < item.at || t >= item.at + item.dur) continue;
    const scale = h / 1080;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    if (item.style === "title") {
      ctx.font = `700 ${Math.round(64 * scale)}px Archivo, ui-sans-serif, sans-serif`;
      ctx.textAlign = "center";
      ctx.shadowColor = "rgba(0,0,0,.55)";
      ctx.shadowBlur = 18 * scale;
      ctx.fillStyle = "#fff";
      ctx.fillText(item.content, w / 2, h / 2);
    } else if (item.style === "lower-third") {
      const pad = 24 * scale;
      ctx.font = `600 ${Math.round(38 * scale)}px Archivo, ui-sans-serif, sans-serif`;
      const width = ctx.measureText(item.content).width;
      const y = h - 140 * scale;
      ctx.fillStyle = "rgba(12,12,12,.8)";
      ctx.fillRect(pad, y - 46 * scale, width + pad * 2, 64 * scale);
      ctx.fillStyle = "#e0a92e";
      ctx.fillRect(pad, y - 46 * scale, 4 * scale, 64 * scale);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.fillText(item.content, pad * 2, y);
    } else {
      ctx.font = `500 ${Math.round(34 * scale)}px Archivo, ui-sans-serif, sans-serif`;
      ctx.textAlign = "center";
      const width = ctx.measureText(item.content).width;
      const y = h - 70 * scale;
      ctx.fillStyle = "rgba(12,12,12,.72)";
      ctx.fillRect(w / 2 - width / 2 - 16 * scale, y - 34 * scale, width + 32 * scale, 48 * scale);
      ctx.fillStyle = "#fff";
      ctx.fillText(item.content, w / 2, y);
    }
    ctx.restore();
  }
}

/**
 * Draw the edit at time `t`. Everything is drawn in composition coordinates
 * and one transform applies the crop, so overlays are reframed by exactly the
 * same maths as the picture rather than by a second, drifting copy of it.
 */
export function composeFrame(
  ctx: Ctx,
  edl: Edl,
  t: Sec,
  /** The frame to draw, or null for a gap, which is black with the effects still on it. */
  pic: Picture | null,
  /** Pixel size of the canvas being drawn into. */
  view: { width: number; height: number },
  /** The window of the frame to show. Preview passes the live crop mid-drag. */
  crop: Crop,
) {
  const W = edl.width;
  const H = edl.height;
  const k = view.width / (W * crop.w);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.setTransform(k, 0, 0, k, -crop.x * W * k, -crop.y * H * k);

  if (pic && pic.width && pic.height) {
    const scale = Math.min(W / pic.width, H / pic.height);
    const dw = pic.width * scale;
    const dh = pic.height * scale;

    // Zoom scales about its focal point inside the crop: punch in, then reframe.
    const zoom = zoomAt(edl, t);
    if (zoom) {
      ctx.save();
      const fx = zoom.x * W;
      const fy = zoom.y * H;
      ctx.translate(fx, fy);
      ctx.scale(zoom.scale, zoom.scale);
      ctx.translate(-fx, -fy);
    }
    ctx.drawImage(pic.source, (W - dw) / 2, (H - dh) / 2, dw, dh);
    if (zoom) ctx.restore();
  }

  // Titles ride above the zoom — a caption that scales with a punch-in reads as a mistake.
  drawText(ctx, edl, t, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // The wash is last, so it covers overlays too, which is what a fade to black means.
  const fade = fadeAt(edl, t);
  if (fade) {
    ctx.save();
    ctx.globalAlpha = fade.alpha;
    ctx.fillStyle = fade.color;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.restore();
  }
}
