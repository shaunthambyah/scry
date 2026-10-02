export const JEV_API_KEY_STORAGE_KEY = "jevApiKey";

/** Reads the key only in an extension page or service worker, never from a destination page. */
export async function readJevApiKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(JEV_API_KEY_STORAGE_KEY);
  const key = stored[JEV_API_KEY_STORAGE_KEY];
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export async function saveJevApiKey(key: string): Promise<void> {
  const normalized = key.trim();
  if (!normalized) throw new Error("Enter an API key before saving.");
  await chrome.storage.local.set({ [JEV_API_KEY_STORAGE_KEY]: normalized });
}

export async function clearJevApiKey(): Promise<void> {
  await chrome.storage.local.remove(JEV_API_KEY_STORAGE_KEY);
}
