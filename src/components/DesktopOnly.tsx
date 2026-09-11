"use client";

import { useEffect, useState } from "react";
import { Logo } from "@/components/ui";

/**
 * The narrowest window the editor claims to work at. Measured, not a
 * breakpoint: at 860 nothing spills out of its row, no click is stolen by the
 * floating transport, ruler labels keep their spacing, and the timeline
 * toolbar still has 51px to spare with a clip selected. It also admits half
 * of a 1728px laptop screen (864px), the usual side-by-side layout. The e2e's
 * `FLOOR` must match it.
 */
export const MIN_WIDTH = 860;

/**
 * The window's width, or 0 before it has been measured.
 *
 * It resolves after mount rather than during render, because the server has no
 * window and a tree that differs between the two is a hydration error. The
 * app's own loading gate covers the frame in between.
 */
export function useWindowWidth(): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const read = () => setW(window.innerWidth);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return w;
}

/**
 * The whole screen, rather than a banner over a broken layout.
 *
 * Editing here means catching a 2px trim handle on a timeline measured in
 * pixels per second. That is not a layout that gets smaller gracefully, and a
 * cramped version of it would be a worse promise than an honest wall — so this
 * says what is missing, in the same numbers the editor works in.
 */
export default function DesktopOnly({ width }: { width: number }) {
  return (
    <div className="flex h-dvh items-center bg-shell px-7">
      <div className="mx-auto w-full max-w-[38ch]">
        <Logo />
        <h1 className="mt-7 text-[21px] font-semibold leading-[1.2] tracking-[-.025em] text-ink">
          Cutline needs a wider screen
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">
          Cutting means catching a two-pixel trim handle on a timeline measured
          in pixels per second. There is not enough width here to work against.
        </p>
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
          Widen the window, or open this page on a larger screen. Nothing needs
          moving — your footage never left this device, and each browser keeps
          its own projects.
        </p>
        <p className="tnum mt-7 border-t border-edge pt-4 font-mono text-[11.5px] text-ink-3">
          this window <span className="text-ink">{width ? `${width}px` : "—"}</span>
          <span className="ml-6">
            needs <span className="text-ink">{MIN_WIDTH}px</span>
          </span>
        </p>
      </div>
    </div>
  );
}
