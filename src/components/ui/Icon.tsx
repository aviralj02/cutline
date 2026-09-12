/**
 * Icons come from lucide. Nothing here is drawn by hand — the one authored
 * mark in this app is the logo, which no library can supply.
 *
 * Names are the role the icon plays in Cutline, not the library's noun, so a
 * swap stays a one-line change here rather than a sweep through components.
 */
import {
  ArrowUp,
  Blend,
  Check,
  ChevronDown,
  ChevronFirst,
  KeyRound,
  LoaderCircle,
  Music,
  Search,
  Volume2,
  VolumeX,
  Square,
  ChevronLast,
  Clapperboard,
  Crop,
  Crosshair,
  Download,
  Delete,
  FilePlus2,
  FolderPlus,
  Film,
  Gauge,
  Minus,
  GitBranch,
  Pause,
  Play,
  RotateCcw,
  Plus,
  Redo2,
  Scissors,
  StepBack,
  StepForward,
  Trash2,
  Type,
  Undo2,
  X,
  ZoomIn,
  type LucideProps,
} from "lucide-react";

export type IconProps = { size?: number; className?: string };

/** 1.75 at these sizes matches the weight of 12–13px Archivo beside it. */
const line = {
  size: 15,
  strokeWidth: 1.75,
  absoluteStrokeWidth: false,
} satisfies LucideProps;

/** Transport marks are solid: a filled triangle reads faster than an outline. */
const solid = {
  size: 13,
  strokeWidth: 1,
  fill: "currentColor",
} satisfies LucideProps;

export const PlayIcon = (p: IconProps) => <Play {...solid} {...p} />;
export const PauseIcon = (p: IconProps) => <Pause {...solid} {...p} />;
export const SplitIcon = (p: IconProps) => <Scissors {...line} {...p} />;
export const TrashIcon = (p: IconProps) => <Trash2 {...line} {...p} />;
export const UndoIcon = (p: IconProps) => <Undo2 {...line} {...p} />;
export const BranchIcon = (p: IconProps) => <GitBranch {...line} {...p} />;
export const FilmIcon = (p: IconProps) => <Film {...line} {...p} />;
export const SendIcon = (p: IconProps) => (
  <ArrowUp {...line} strokeWidth={2.25} {...p} />
);
export const CropIcon = (p: IconProps) => <Crop {...line} {...p} />;
export const ResetIcon = (p: IconProps) => <RotateCcw {...line} {...p} />;
export const SpeedIcon = (p: IconProps) => <Gauge {...line} {...p} />;

export const StartIcon = (p: IconProps) => <ChevronFirst {...line} {...p} />;
export const EndIcon = (p: IconProps) => <ChevronLast {...line} {...p} />;
export const PrevFrameIcon = (p: IconProps) => <StepBack {...line} {...p} />;
export const NextFrameIcon = (p: IconProps) => <StepForward {...line} {...p} />;
export const AddIcon = (p: IconProps) => <Plus {...line} {...p} />;
export const CloseIcon = (p: IconProps) => <X {...line} {...p} />;
export const FadeTrackIcon = (p: IconProps) => <Blend {...line} {...p} />;
export const ZoomTrackIcon = (p: IconProps) => <ZoomIn {...line} {...p} />;
export const TextTrackIcon = (p: IconProps) => <Type {...line} {...p} />;
export const SoundTrackIcon = (p: IconProps) => <Music {...line} {...p} />;
export const SoundOnIcon = (p: IconProps) => <Volume2 {...line} {...p} />;
export const SoundOffIcon = (p: IconProps) => <VolumeX {...line} {...p} />;

/**
 * Timeline magnification, not the zoom effect. A stepper either side of a
 * readout is what every editor uses for this, and it shares its glyph with
 * `AddIcon` on purpose — flanking "3×" it can only mean one thing, whereas a
 * magnifier would read as `ZoomTrackIcon`, which is a different feature.
 */
export const ScaleInIcon = (p: IconProps) => <Plus {...line} {...p} />;
export const ScaleOutIcon = (p: IconProps) => <Minus {...line} {...p} />;

export const FocusIcon = (p: IconProps) => <Crosshair {...line} {...p} />;

export const BackspaceIcon = (p: IconProps) => (
  <Delete {...line} strokeWidth={1.6} {...p} />
);
export const AddMediaIcon = (p: IconProps) => <FilePlus2 {...line} {...p} />;
export const UndoActionIcon = (p: IconProps) => <Undo2 {...line} {...p} />;
export const RedoActionIcon = (p: IconProps) => <Redo2 {...line} {...p} />;
export const NewProjectIcon = (p: IconProps) => <FolderPlus {...line} {...p} />;
export const ExportIcon = (p: IconProps) => <Clapperboard {...line} {...p} />;
export const SaveIcon = (p: IconProps) => <Download {...line} {...p} />;

export const GithubIcon = ({ size = 15, className = "" }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

/* The agent's controls. Stop is solid, like the transport marks it sits beside. */
export const StopIcon = (p: IconProps) => <Square {...solid} {...p} />;
export const KeyIcon = (p: IconProps) => <KeyRound {...line} {...p} />;
export const ChevronIcon = (p: IconProps) => <ChevronDown {...line} {...p} />;
export const CheckIcon = (p: IconProps) => <Check {...line} {...p} />;
export const SearchIcon = (p: IconProps) => <Search {...line} {...p} />;
export const WorkingIcon = ({ className = "", ...p }: IconProps) => (
  <LoaderCircle {...line} {...p} className={`animate-spin ${className}`} />
);
