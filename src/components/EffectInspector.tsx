"use client";

import { useStore, useEdl } from "@/lib/store";
import { fmt } from "@/lib/edl/query";
import { FADE_COLORS, findEffect, removeEffect, trackOfEffect, updateEffect } from "@/lib/edl/ops";
import { Button, FocusIcon, Segmented, Slider, Swatches, TrashIcon } from "@/components/ui";

/**
 * Contextual controls for the selected effect, in a strip under the lanes
 * rather than a modal or a far-away panel — you adjust a fade while watching
 * the fade, and the playhead is right there.
 */
export default function EffectInspector() {
  const selected = useStore((s) => s.selectedEffect);
  const selectEffect = useStore((s) => s.selectEffect);
  const apply = useStore((s) => s.apply);
  const setDraft = useStore((s) => s.setDraft);
  const commitDraft = useStore((s) => s.commitDraft);
  const media = useStore((s) => s.media);

  const edl = useEdl();
  const effect = selected ? findEffect(edl, selected) : null;
  const track = selected ? trackOfEffect(edl, selected) : null;

  /**
   * The strip is always present, even with nothing selected. Letting it
   * appear and disappear resizes the card, which shoves every lane upward
   * the moment you add an effect — the timeline jumps out from under the
   * cursor that just used it.
   */
  if (!effect || !track) {
    return (
      <div className="flex h-[46px] items-center border-t border-edge bg-white/[.02] px-3.5 text-[12px] text-ink-3">
        Select a fade, zoom or sound to adjust it
      </div>
    );
  }

  /** Discrete choices are one decision, so they commit immediately. */
  const patch = (p: Record<string, unknown>, label: string) =>
    apply(updateEffect(edl, effect.id, p as never), label);

  /**
   * Continuous controls preview through the draft and write a single version
   * when the drag ends. Committing per input event would put a hundred
   * near-identical entries in the history for one slider pull.
   */
  const scrubParam = (p: Record<string, unknown>) =>
    setDraft(updateEffect(edl, effect.id, p as never));

  return (
    <div className="flex h-[46px] items-center gap-x-5 overflow-x-auto border-t border-edge bg-white/[.02] px-3.5">
      <span className="text-[12.5px] font-medium text-ink">{track.name}</span>
      <span className="tnum font-mono text-[11px] text-ink-3">
        {fmt(effect.at)} for {effect.dur.toFixed(2)}s
      </span>

      {effect.kind === "sound" ? (
        <>
          <span className="max-w-[14rem] truncate text-[12px] text-ink-2">
            {media.find((m) => m.id === effect.src)?.name ?? "Sound"}
          </span>
          <span className="tnum shrink-0 font-mono text-[11px] text-ink-3">from {fmt(effect.in)}</span>
          <Slider
            label="Volume"
            min={0}
            max={1}
            step={0.01}
            value={effect.volume}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(volume) => scrubParam({ volume })}
            onCommit={() => commitDraft("Sound volume")}
          />
        </>
      ) : effect.kind === "fade" ? (
        <>
          <Segmented
            label="Fade direction"
            options={["in", "out", "dip"] as const}
            value={effect.mode}
            onChange={(m) => patch({ mode: m }, `Fade ${m}`)}
            format={(m) => (m === "in" ? "From" : m === "out" ? "To" : "Through")}
            title={(m) =>
              m === "in"
                ? "Open from the colour"
                : m === "out"
                  ? "Close to the colour"
                  : "Dip through the colour and back"
            }
          />
          <Swatches
            label="Fade colour"
            colors={FADE_COLORS}
            value={effect.color}
            onChange={(color) => patch({ color }, "Fade colour")}
          />
        </>
      ) : (
        <>
          <Slider
            label="Scale"
            min={1}
            max={4}
            step={0.05}
            value={effect.scale}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(scale) => scrubParam({ scale })}
            onCommit={() => commitDraft("Zoom scale")}
          />
          <Slider
            label="Ease"
            min={0}
            max={2}
            step={0.05}
            value={effect.ramp}
            format={(v) => `${v.toFixed(2)}s`}
            onChange={(ramp) => scrubParam({ ramp })}
            onCommit={() => commitDraft("Zoom ease")}
          />
          {/* Position is set by the target on the picture, so the panel
              reports it rather than offering a second way to change it. */}
          <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <FocusIcon size={13} className="text-leader" />
            Drag the target on the picture
            <span className="tnum font-mono text-[11px] text-ink-2">
              {Math.round(effect.x * 100)}%, {Math.round(effect.y * 100)}%
            </span>
          </span>
        </>
      )}

      <Button
        variant="danger"
        icon={<TrashIcon />}
        className="ml-auto"
        onClick={() => {
          selectEffect(null);
          apply(removeEffect(edl, effect.id), `Remove ${track.name.toLowerCase()}`);
        }}
      >
        Remove
      </Button>
    </div>
  );
}
