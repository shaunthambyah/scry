export type ScoringModel = "auto" | "mock" | "jev" | "clef-flash" | "clef" | "consensus";
export type ScoringMode = ScoringModel;
export const SCORING_MODEL_KEY = "scryScoringModel";
export const CLOUDFLARE_WORKER_URL_KEY = "scryCloudflareWorkerUrl";
export const RECENT_SCORING_MODE_KEY = "scryRecentScoringMode";

export interface ScoringSettings { model: ScoringModel; cloudflareWorkerUrl: string; }
export const DEFAULT_SCORING_SETTINGS: ScoringSettings = { model: "auto", cloudflareWorkerUrl: "" };

export async function readScoringSettings(): Promise<ScoringSettings> {
  const stored = await chrome.storage.local.get([SCORING_MODEL_KEY, CLOUDFLARE_WORKER_URL_KEY]);
  const model = stored[SCORING_MODEL_KEY];
  return {
    model: model === "mock" || model === "jev" || model === "clef-flash" || model === "clef" || model === "consensus" ? model : "auto",
    cloudflareWorkerUrl: typeof stored[CLOUDFLARE_WORKER_URL_KEY] === "string" ? stored[CLOUDFLARE_WORKER_URL_KEY].trim() : ""
  };
}

export async function readRecentScoringMode(): Promise<ScoringMode | null> {
  const stored = await chrome.storage.local.get([RECENT_SCORING_MODE_KEY]);
  const mode = stored[RECENT_SCORING_MODE_KEY];
  return mode === "auto" || mode === "mock" || mode === "jev" || mode === "clef-flash" || mode === "clef" || mode === "consensus" ? mode : null;
}

export async function saveRecentScoringMode(mode: ScoringMode): Promise<void> {
  await chrome.storage.local.set({ [RECENT_SCORING_MODE_KEY]: mode });
}

export async function saveScoringModel(model: ScoringModel): Promise<void> {
  await chrome.storage.local.set({ [SCORING_MODEL_KEY]: model });
}

export async function saveCloudflareWorkerUrl(url: string): Promise<void> {
  const normalized = url.trim();
  if (normalized) {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("Scoring Worker URL must use HTTPS.");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Use a Worker endpoint URL without embedded credentials, query parameters, or a fragment.");
    if (parsed.pathname !== "/score") throw new Error("Use the Worker /score endpoint.");
  }
  await chrome.storage.local.set({ [CLOUDFLARE_WORKER_URL_KEY]: normalized });
}
