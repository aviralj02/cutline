/**
 * Media lives in the Origin Private File System: on the user's disk, in the
 * browser's sandbox. Nothing uploads, so import is instant regardless of file
 * size and a 4GB source costs nothing to host.
 */
const DIR = "media";

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export const opfsSupported = () =>
  typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;

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
    (await dir()).removeEntry(id);
  } catch {
    /* already gone */
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
