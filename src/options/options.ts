import { clearJevApiKey, readJevApiKey, saveJevApiKey } from "../storage/jevCredentials.js";
import { readScoringSettings, saveCloudflareWorkerUrl, saveScoringModel, type ScoringModel } from "../storage/scoringSettings.js";

const modelSelect = document.querySelector<HTMLSelectElement>("#scoring-model")!;
const workerInput = document.querySelector<HTMLInputElement>("#worker-url")!;
const workerState = document.querySelector<HTMLElement>("#worker-state")!;
const keyInput = document.querySelector<HTMLInputElement>("#api-key")!;
const keyState = document.querySelector<HTMLElement>("#key-state")!;
const status = document.querySelector<HTMLElement>("#status")!;
const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai/*";

function showStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function refresh(): Promise<void> {
  const [settings, apiKey, hasPermission] = await Promise.all([
    readScoringSettings(), readJevApiKey(), chrome.permissions.contains({ origins: [TYPESAFE_API_ORIGIN] })
  ]);
  modelSelect.value = settings.model;
  workerInput.value = settings.cloudflareWorkerUrl;
  workerState.textContent = settings.cloudflareWorkerUrl ? "Worker URL saved in this Chrome profile." : "No Worker URL saved.";
  if (!apiKey) keyState.textContent = "No key is saved.";
  else if (hasPermission) keyState.textContent = "A TypeSafe key is saved and API access is allowed. The key itself is never displayed.";
  else keyState.textContent = "A TypeSafe key is saved, but API access is not allowed.";
}

modelSelect.addEventListener("change", async () => {
  try {
    await saveScoringModel(modelSelect.value as ScoringModel);
    showStatus("Scoring model saved. It will apply to the next research run.");
  } catch (error) { showStatus(error instanceof Error ? error.message : "Could not save the scoring model.", true); }
});

document.querySelector<HTMLButtonElement>("#save-worker")!.addEventListener("click", async () => {
  const value = workerInput.value.trim();
  try {
    if (value) {
      const endpoint = new URL(value);
      if ((endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") || endpoint.pathname !== "/score" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error("Enter the HTTPS Worker /score URL without credentials or query parameters.");
      }
      const originPattern = `${endpoint.origin}/*`;
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error("Chrome did not grant access to the Scoring Worker.");
    }
    await saveCloudflareWorkerUrl(value);
    workerState.textContent = value ? "Worker URL saved and host access granted." : "Worker URL cleared.";
    showStatus("Cloudflare Scoring Worker settings saved for the next research run.");
  } catch (error) { showStatus(error instanceof Error ? error.message : "Could not save the Worker URL.", true); }
});

document.querySelector<HTMLButtonElement>("#clear-worker")!.addEventListener("click", async () => {
  try {
    await saveCloudflareWorkerUrl("");
    workerInput.value = "";
    workerState.textContent = "No Worker URL saved.";
    showStatus("Scoring Worker URL removed.");
  } catch (error) { showStatus(error instanceof Error ? error.message : "Could not remove the Worker URL.", true); }
});

document.querySelector<HTMLButtonElement>("#save-key")!.addEventListener("click", async () => {
  if (!keyInput.value.trim()) { showStatus("Enter a Jev API key before saving.", true); return; }
  try {
    const granted = await chrome.permissions.request({ origins: [TYPESAFE_API_ORIGIN] });
    if (!granted) throw new Error("TypeSafe API access was not granted.");
    await saveJevApiKey(keyInput.value);
    keyInput.value = "";
    await refresh();
    showStatus("Jev API key saved. Automatic scoring will use Jev on the next run.");
  } catch (error) { showStatus(error instanceof Error ? error.message : "Could not save the Jev API key.", true); }
});

document.querySelector<HTMLButtonElement>("#allow-api")!.addEventListener("click", async () => {
  try {
    const granted = await chrome.permissions.request({ origins: [TYPESAFE_API_ORIGIN] });
    await refresh();
    showStatus(granted ? "TypeSafe API access granted." : "TypeSafe API access was not granted.", !granted);
  } catch (error) { showStatus(error instanceof Error ? error.message : "Could not request TypeSafe API access.", true); }
});

document.querySelector<HTMLButtonElement>("#clear-key")!.addEventListener("click", async () => {
  try {
    await clearJevApiKey();
    keyInput.value = "";
    await refresh();
    showStatus("Saved Jev API key removed.");
  } catch (error) { showStatus(error instanceof Error ? error.message : "Could not remove the Jev API key.", true); }
});

void refresh().catch(() => { keyState.textContent = "Could not read saved settings."; showStatus("Chrome storage is unavailable.", true); });
