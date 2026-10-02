import { GoogleSearchResultProvider } from "./googleSerpParser.js";

type ScoringChoice = { id: string; label: string; available: boolean };
type ChoiceResponse = { models: ScoringChoice[]; consensusAvailable: boolean; defaultMode: string };
const provider = new GoogleSearchResultProvider(document, location.href);
let activeNormalizedQuery = provider.getQuery().normalized;
let root: HTMLDivElement | null = null;
let mainButton: HTMLButtonElement | null = null;
let menuButton: HTMLButtonElement | null = null;
let menu: HTMLDivElement | null = null;
let selectedMode = "auto";
let choiceState: ChoiceResponse = { models: [], consensusAvailable: false, defaultMode: "auto" };

async function refreshChoices(): Promise<void> {
  try {
    choiceState = await chrome.runtime.sendMessage<ChoiceResponse>({ type: "GET_SCORING_CHOICES" });
    selectedMode = choiceState.defaultMode || "auto";
    if (selectedMode === "consensus" && !choiceState.consensusAvailable) selectedMode = choiceState.models.find((model) => model.available)?.id ?? "auto";
    if (["jev", "clef", "clef-flash"].includes(selectedMode) && !choiceState.models.some((model) => model.id === selectedMode && model.available)) {
      selectedMode = choiceState.models.find((model) => model.available)?.id ?? "auto";
    }
  } catch { /* The main button retains the settings default when the worker is unavailable. */ }
}

function closeMenu(returnFocus = false): void {
  if (!menu) return;
  menu.hidden = true;
  menuButton?.setAttribute("aria-expanded", "false");
  if (returnFocus) menuButton?.focus();
}

function openMenu(): void {
  if (!menu || !menuButton) return;
  buildMenu();
  menu.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
  menu.querySelector<HTMLButtonElement>("[role=menuitemradio]:not(:disabled)")?.focus();
}

function pickMode(mode: string): void {
  selectedMode = mode;
  void chrome.runtime.sendMessage({ type: "SET_SCORING_MODE", mode });
  closeMenu(true);
}

function buildMenu(): void {
  if (!menu) return;
  menu.replaceChildren();
  const title = document.createElement("div");
  title.className = "scry-menu-title";
  title.textContent = "Scoring for this search";
  menu.append(title);
  const modes = [...choiceState.models.map((model) => ({ ...model, mode: model.id, description: "" }))];
  const availableNames = choiceState.models.filter((model) => model.available).map((model) => model.label);
  modes.push({ id: "consensus", label: "Consensus", available: choiceState.consensusAvailable, mode: "consensus", description: choiceState.consensusAvailable ? availableNames.join(" + ") : "Requires at least 2 configured models" });
  for (const choice of modes) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "scry-menu-item";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(selectedMode === choice.mode));
    item.disabled = !choice.available;
    const label = document.createElement("span");
    label.textContent = choice.label;
    item.append(label);
    if (choice.description) {
      const detail = document.createElement("small");
      detail.textContent = choice.description;
      item.append(detail);
    } else if (!choice.available) {
      const detail = document.createElement("small");
      detail.textContent = "unavailable";
      item.append(detail);
    }
    item.addEventListener("click", () => pickMode(choice.mode));
    menu.append(item);
  }
}

async function startResearch(): Promise<void> {
  const query = provider.getQuery();
  const results = provider.getResults();
  if (!mainButton || mainButton.disabled) return;
  mainButton.disabled = true;
  mainButton.textContent = "Opening research…";
  try {
    await chrome.runtime.sendMessage({ type: "START_RESEARCH", query, results, scoringMode: selectedMode });
  } catch (error) {
    console.warn("Scry could not start research", error);
  } finally {
    if (mainButton?.isConnected) {
      mainButton.disabled = false;
      mainButton.textContent = "Research these results";
    }
  }
}

function createControl(): void {
  root = document.createElement("div");
  root.className = "scry-split-control";
  mainButton = document.createElement("button");
  mainButton.type = "button";
  mainButton.className = "scry-research-button";
  mainButton.textContent = "Research these results";
  mainButton.addEventListener("click", () => void startResearch());
  menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "scry-menu-toggle";
  menuButton.textContent = "▾";
  menuButton.setAttribute("aria-label", "Choose scoring for this search");
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-expanded", "false");
  menuButton.addEventListener("click", () => menu?.hidden ? openMenu() : closeMenu());
  menu = document.createElement("div");
  menu.className = "scry-scorer-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Scoring for this search");
  menu.hidden = true;
  root.append(mainButton, menuButton, menu);
  document.addEventListener("pointerdown", (event) => {
    if (root && event.target instanceof Node && !root.contains(event.target)) closeMenu();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeMenu(true); return; }
    if (!menu || menu.hidden || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]:not(:disabled)")];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : current < 0
      ? event.key === "ArrowDown" ? 0 : items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
}

function ensureControl(): void {
  const query = provider.getQuery();
  const results = provider.getResults();
  if (!query.text || !results.length) {
    root?.remove();
    root = null;
    mainButton = null;
    menuButton = null;
    menu = null;
    return;
  }
  if (!root) createControl();
  if (!root!.isConnected) document.documentElement.append(root!);
}

new MutationObserver(ensureControl).observe(document.documentElement, { subtree: true, childList: true });
void refreshChoices().then(ensureControl);
ensureControl();
window.setInterval(() => {
  const nextQuery = provider.getQuery().normalized;
  if (activeNormalizedQuery && nextQuery && nextQuery !== activeNormalizedQuery) {
    void chrome.runtime.sendMessage({ type: "QUERY_CHANGED", query: nextQuery });
    void refreshChoices();
  }
  activeNormalizedQuery = nextQuery;
  ensureControl();
}, 900);
