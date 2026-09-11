/** Media lives in OPFS, on disk in the browser's sandbox: nothing uploads, and checkRoom asks about space first. */
const DIR = "media";

/** Per-file import cap, sized for everyday phone and screen footage; import streams, so memory isn't what it guards. */
export const MAX_FILE_BYTES = 4 * 1024 ** 3;

export const humanBytes = (n: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 1 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[i]}`;
};

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export const opfsSupported = () =>
  typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;

/**
 * Ask whether a file can be stored before spending minutes analysing it.
 * The quota is per-origin and varies with the disk, so the honest answer comes
 * from the browser rather than from a constant.
 */
export async function checkRoom(file: File): Promise<string | null> {
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${humanBytes(file.size)}. Cutline takes files up to ${humanBytes(MAX_FILE_BYTES)}; trim or compress it first.`;
  }
  try {
    const { used, quota } = await usage();
    // Headroom for the project record and the browser's own overhead.
    const free = quota - used - 64 * 1024 * 1024;
    if (quota > 0 && file.size > free) {
      return `${file.name} is ${humanBytes(file.size)} but this browser has ${humanBytes(Math.max(0, free))} free for Cutline. Free up space, or start a new project to clear the current footage.`;
    }
  } catch {
    /* no estimate available; let the write decide */
  }
  return null;
}

/**
 * Ask the browser to stop treating this origin's storage as evictable. It is
 * a request, not a guarantee, and a refusal is not a failure — the footage is
 * still written either way.
 */
export async function keepStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function putMedia(id: string, file: File): Promise<void> {
  const d = await dir();
  const handle = await d.getFileHandle(id, { create: true });
  const w = await handle.createWritable();
  await w.write(file);
  await w.close();
}

export async function getMedia(id: string): Promise<File | null> {
  try {
    const d = await dir();
    return await (await d.getFileHandle(id)).getFile();
  } catch {
    return null;
  }
}

export async function deleteMedia(id: string): Promise<void> {
  try {
    await (await dir()).removeEntry(id);
  } catch {
    /* already gone */
  }
}

/**
 * Delete every stored file, not just the ones the current project knows
 * about. Removing the whole directory also sweeps footage left behind by
 * resets from before this cleaned up after itself.
 */
export async function clearMedia(): Promise<void> {
  releaseUrls();
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(DIR, { recursive: true });
  } catch {
    /* nothing stored yet */
  }
}

const urls = new Map<string, string>();

/** Object URL for a stored file, cached so <video> elements stay warm. */
export async function mediaUrl(id: string): Promise<string | null> {
  const cached = urls.get(id);
  if (cached) return cached;
  const file = await getMedia(id);
  if (!file) return null;
  const url = URL.createObjectURL(file);
  urls.set(id, url);
  return url;
}

export function releaseUrls() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
}

export async function usage(): Promise<{ used: number; quota: number }> {
  const e = await navigator.storage?.estimate?.();
  return { used: e?.usage ?? 0, quota: e?.quota ?? 0 };
}
