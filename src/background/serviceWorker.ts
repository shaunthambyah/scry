import type { ExtractedPage, PassageScorer, ResearchRun, ResearchRunView, SearchQuery, SearchResult, SourceDocument, SourceLifecycle } from "../models/types.js";
import { applyRunRanking, createResearchRun, processResearchRun, scoreFrozenCandidates } from "../pipeline/researchPipeline.js";
import { JevPassageScorer, MockPassageScorer, TypeSafeJevTransport } from "../ranking/jevClient.js";
import { makeSourceText } from "../extraction/extractMainContent.js";
import { locateAndHighlightEvidence } from "../content/evidenceAnchor.js";
import { openOrReuseAndAnchor, sourceIdentity, type SourceTabsApi } from "./sourceTabs.js";
import { evidenceTextFragmentUrl } from "../sidepanel/evidenceNavigation.js";
import { readJevApiKey } from "../storage/jevCredentials.js";
import { readRecentScoringMode, readScoringSettings, saveRecentScoringMode, type ScoringMode } from "../storage/scoringSettings.js";
import { CloudflareClefHttpTransport, CloudflareClefScorer } from "../scoring/cloudflareClefScorer.js";
import { hasResearchHostPermission, researchHostOrigins } from "./hostPermissions.js";

const SESSION_KEY = "scryActiveResearchRun";
const SESSION_TAB_KEY = "scryResearchTabId";
const MAX_HTML_BYTES = 2_500_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONCURRENCY = 4;
const GOOGLE_GOTO_FILTERS = [
  "https://*.google.com/goto*", "https://*.google.com.au/goto*", "https://*.google.co.uk/goto*",
  "https://*.google.ca/goto*", "https://*.google.co.nz/goto*", "https://*.google.de/goto*",
  "https://*.google.fr/goto*", "https://*.google.it/goto*", "https://*.google.es/goto*",
  "https://*.google.co.in/goto*", "https://*.google.co.jp/goto*", "https://*.google.com.br/goto*",
  "https://*.google.com.sg/goto*", "https://*.google.co.kr/goto*", "https://*.google.nl/goto*",
  "https://*.google.com.mx/goto*"
];
interface PendingGoogleRedirect { resolve: (destination: string) => void }
const pendingGoogleRedirects = new Map<string, PendingGoogleRedirect>();
let currentRun: ResearchRun | null = null;
let currentRunId: string | null = null;
let activeTabId: number | null = null;
let activeAbortController: AbortController | null = null;
let offscreenReady: Promise<void> | null = null;

chrome.webRequest.onBeforeRedirect.addListener((details) => {
  pendingGoogleRedirects.get(details.url)?.resolve(details.redirectUrl);
}, { urls: GOOGLE_GOTO_FILTERS });

function cleanLegacyDetails(run: ResearchRun): ResearchRun {
  const cleaned = structuredClone(run);
  const legacyRun = cleaned as unknown as Record<string, unknown>;
  delete legacyRun.debug;
  delete legacyRun.metrics;
  delete legacyRun.facets;
  delete legacyRun.evidenceGroups;
  delete legacyRun.startedAt;
  delete legacyRun.completedAt;
  delete legacyRun.hostPermissionStatus;
  const query = cleaned.query as unknown as Record<string, unknown>;
  delete query.capturedAt;
  const scoring = cleaned.scoring as unknown as Record<string, unknown> | undefined;
  if (scoring) {
    const oldFailures = scoring.failedScorers;
    scoring.failedScorerIds ??= Array.isArray(oldFailures)
      ? oldFailures.flatMap((failure) => failure && typeof failure === "object" && typeof (failure as { scorerId?: unknown }).scorerId === "string" ? [(failure as { scorerId: string }).scorerId] : [])
      : [];
    delete scoring.failedScorers;
  }
  if (cleaned.candidateSet) {
    const { candidates, frozen } = cleaned.candidateSet;
    cleaned.candidateSet = { candidates, frozen };
  }
  for (const source of cleaned.sources) {
    const legacySource = source as unknown as Record<string, unknown>;
    delete legacySource.candidateCount;
    if (source.document) {
      const document = source.document as unknown as Record<string, unknown>;
      delete document.retrievedAt;
      delete document.extractionMethod;
    }
  }
  const stripLegacyPassageDetails = (item: ScoredPassage, retainScorerCount: boolean) => {
    const legacyItem = item as unknown as Record<string, unknown>;
    const judgments = legacyItem.judgments;
    if (retainScorerCount && item.scorerCount === undefined && Array.isArray(judgments)) item.scorerCount = judgments.length;
    delete legacyItem.judgments;
    delete legacyItem.directness;
    delete legacyItem.facetIds;
    delete legacyItem.cluster;
    delete legacyItem.fusedScore;
  };
  for (const item of cleaned.evidence) stripLegacyPassageDetails(item, true);
  for (const judgments of Object.values(cleaned.modelJudgments ?? {})) {
    for (const item of judgments) stripLegacyPassageDetails(item, false);
  }
  for (const score of cleaned.sourceScores) {
    const legacyScore = score as unknown as Record<string, unknown>;
    delete legacyScore.sourceRankScore;
    delete legacyScore.coverageBonus;
    delete legacyScore.coverageFacetCount;
    delete legacyScore.usefulPassageCount;
    delete legacyScore.scoredPassageCount;
    delete legacyScore.rankContributions;
  }
  return cleaned;
}

function sessionSnapshot(run: ResearchRun): ResearchRun {
  const cleaned = cleanLegacyDetails(run);
  return {
    ...cleaned,
    sources: cleaned.sources.map((source) => ({
      ...source,
      document: source.document ? { ...source.document, sourceText: "", blocks: [] } : undefined
    }))
  };
}

function panelSnapshot(run: ResearchRun): ResearchRunView {
  const snapshot = sessionSnapshot(run);
  const canAddModels = Boolean(snapshot.candidateSet?.frozen && snapshot.candidateSet.candidates.length);
  const { candidateSet: _candidateSet, modelJudgments: _modelJudgments, ...visibleRun } = snapshot;
  return structuredClone({ ...visibleRun, canAddModels });
}

function sendUpdate(run: ResearchRun): void {
  currentRun = run;
  void chrome.storage.session.set({ [SESSION_KEY]: sessionSnapshot(run) });
  void chrome.runtime.sendMessage({ type: "RUN_UPDATED", run: panelSnapshot(run) }).catch(() => undefined);
}

async function restoreRunFromSession(): Promise<void> {
  const stored = await chrome.storage.session.get([SESSION_KEY, SESSION_TAB_KEY]);
  const savedRun = stored[SESSION_KEY] as ResearchRun | undefined;
  currentRun = savedRun ? cleanLegacyDetails(savedRun) : null;
  activeTabId = typeof stored[SESSION_TAB_KEY] === "number" ? stored[SESSION_TAB_KEY] as number : null;
  if (currentRun) await chrome.storage.session.set({ [SESSION_KEY]: sessionSnapshot(currentRun) });
}

async function ensureOffscreen(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: "offscreen/index.html",
          reasons: ["DOM_PARSER"],
          justification: "Parse retrieved destination page HTML into source text and structural blocks."
        });
      }
    })().catch((error) => { offscreenReady = null; throw error; });
  }
  await offscreenReady;
}

async function parseInOffscreen(html: string, url: string): Promise<{ extracted: ExtractedPage; canonicalUrl?: string }> {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage<{ ok?: boolean; error?: string; extracted?: ExtractedPage; canonicalUrl?: string }>({ type: "PARSE_DESTINATION_HTML", html, url });
  if (!response?.ok) throw new Error(response?.error || "Could not parse destination HTML.");
  return { extracted: response.extracted as ExtractedPage, canonicalUrl: response.canonicalUrl as string | undefined };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceTabsApi(): SourceTabsApi {
  return {
    query: (queryInfo) => chrome.tabs.query(queryInfo),
    create: (properties) => chrome.tabs.create(properties),
    update: (tabId, properties) => chrome.tabs.update(tabId, properties),
    get: (tabId) => chrome.tabs.get(tabId),
    focusWindow: (windowId) => chrome.windows.update(windowId, { focused: true }),
    onUpdated: chrome.tabs.onUpdated
  };
}

async function openEvidenceAtSource(payload: { runId: string; passageId: string }): Promise<{ handled: boolean; ok?: boolean }> {
  const run = currentRun?.runId === payload.runId
    ? currentRun
    : (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as ResearchRun | undefined;
  const evidence = run?.runId === payload.runId
    ? run.evidence.find(({ passage }) => passage.id === payload.passageId)
    : undefined;
  if (!run || !evidence || evidence.provenanceVerified !== true) return { handled: false };
  const passage = evidence.passage;
  const source = run.sources.find(({ result }) => result.id === passage.sourceId);
  const canonicalUrl = source?.document?.url;
  const sourceUrl = canonicalUrl && sourceIdentity(canonicalUrl) === sourceIdentity(passage.url) ? canonicalUrl : passage.url;
  const initialUrl = evidenceTextFragmentUrl(sourceUrl, passage);

  let currentWindowId: number | undefined;
  if (activeTabId !== null) {
    try { currentWindowId = (await chrome.tabs.get(activeTabId)).windowId; } catch { /* Fall through to the focused window. */ }
  }
  if (currentWindowId === undefined) {
    try { currentWindowId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.windowId; }
    catch { /* The opened tab can still be selected without a preferred window. */ }
  }

  const tabs = sourceTabsApi();
  let permissionAvailable = false;
  try {
    const origin = new URL(sourceUrl).origin;
    permissionAvailable = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch { /* Source navigation still works when permission state cannot be read. */ }

  const navigation = await openOrReuseAndAnchor(
    tabs,
    sourceUrl,
    initialUrl,
    currentWindowId,
    async (tabId) => {
      if (!permissionAvailable) return false;
      try {
        // A few retries support pages that finish loading before their article text is rendered.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const [injection] = await chrome.scripting.executeScript<ReturnType<typeof locateAndHighlightEvidence>>({
            target: { tabId },
            func: locateAndHighlightEvidence,
            args: [{
              runId: payload.runId,
              passageId: passage.id,
              text: passage.text,
              previousText: passage.previousText,
              nextText: passage.nextText
            }]
          });
          if (injection?.result?.found) return true;
          const reason = injection?.result?.reason ?? "no injection result";
          if (reason !== "exact-passage-not-found" || attempt === 4) return false;
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      } catch { return false; }
      return false;
    }
  );

  if (!navigation.loaded) return { handled: true, ok: false };
  return { handled: true, ok: navigation.anchored };
}

function safeCanonical(canonical: string | undefined, finalUrl: string): string {
  if (!canonical) return finalUrl;
  try {
    const candidate = new URL(canonical, finalUrl);
    return /^https?:$/.test(candidate.protocol) ? candidate.href : finalUrl;
  } catch { return finalUrl; }
}

async function loadSource(result: SearchResult, setStage: (stage: SourceLifecycle) => void, runSignal?: AbortSignal): Promise<SourceDocument> {
  setStage("fetching");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
  const abortFromRun = () => controller.abort();
  if (runSignal?.aborted) controller.abort();
  else runSignal?.addEventListener("abort", abortFromRun, { once: true });
  let response: Response;
  let html: string;
  try {
    response = await globalThis.fetch(result.url, { redirect: "follow", signal: controller.signal, credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    const announcedLength = Number(response.headers.get("content-length") ?? 0);
    if (announcedLength > MAX_HTML_BYTES) throw new Error(`Page exceeded the ${MAX_HTML_BYTES.toLocaleString()} byte safety limit.`);
    if (!response.body) throw new Error("Page returned no response body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error(`Page exceeded the ${MAX_HTML_BYTES.toLocaleString()} byte safety limit.`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    html = new TextDecoder("utf-8").decode(bytes);
  } catch (error) {
    if (timedOut) throw new Error(`Timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
    if (runSignal?.aborted) throw new Error("Research run cancelled.");
    throw new Error(error instanceof Error ? error.message : "Network request failed.");
  } finally {
    clearTimeout(timeout);
    runSignal?.removeEventListener("abort", abortFromRun);
  }
  if (html.length < 80) throw new Error("Page returned too little HTML to extract content.");
  setStage("extracting");
  const { extracted, canonicalUrl } = await parseInOffscreen(html, response.url || result.url);
  const sourceText = makeSourceText(extracted.blocks);
  if (sourceText.length < 100) throw new Error("No substantial main content was found.");
  const finalUrl = safeCanonical(canonicalUrl, response.url || result.url);
  let domain: string;
  try { domain = new URL(finalUrl).hostname.replace(/^www\./, ""); } catch { domain = result.domain; }
  return {
    sourceId: result.id,
    result,
    url: finalUrl,
    title: extracted.title || result.title,
    domain,
    faviconUrl: extracted.faviconUrl,
    documentHash: await sha256(sourceText),
    documentLength: sourceText.length,
    sourceText,
    blocks: extracted.blocks,
    status: "complete"
  };
}

function isGoogleHost(hostname: string): boolean {
  return /(^|\.)google\.[^.]+(?:\.[^.]+)?$/i.test(hostname);
}

function isGoogleGotoUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return isGoogleHost(url.hostname) && url.pathname === "/goto" && url.searchParams.has("url");
  } catch { return false; }
}

function requestGoogleGotoDestination(rawUrl: string, method: "HEAD" | "GET", runSignal: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const requestKey = new URL(rawUrl).href;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    let responseGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (destination?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (responseGraceTimer) clearTimeout(responseGraceTimer);
      pendingGoogleRedirects.delete(requestKey);
      runSignal.removeEventListener("abort", abortRun);
      controller.abort();
      resolve(destination);
    };
    const abortRun = (): void => finish();
    pendingGoogleRedirects.set(requestKey, { resolve: (destination) => finish(destination) });
    timeout = setTimeout(() => finish(), 7_000);
    if (runSignal.aborted) { finish(); return; }
    runSignal.addEventListener("abort", abortRun, { once: true });
    void globalThis.fetch(rawUrl, {
      method,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    }).then((response) => {
      const location = response.headers.get("location");
      let destination: string | undefined;
      if (location) {
        try { destination = new URL(location, rawUrl).href; }
        catch { /* Treat an invalid Location as an unresolved result. */ }
      }
      void response.body?.cancel().catch(() => undefined);
      if (destination) {
        finish(destination);
      } else if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        responseGraceTimer = setTimeout(() => finish(), 250);
      } else {
        finish();
      }
    }).catch(() => finish());
  });
}

async function resolveGoogleGotoResult(result: SearchResult, runSignal: AbortSignal): Promise<SearchResult> {
  if (!isGoogleGotoUrl(result.url)) return result;
  let destination = await requestGoogleGotoDestination(result.url, "HEAD", runSignal);
  if (!destination && !runSignal.aborted) destination = await requestGoogleGotoDestination(result.url, "GET", runSignal);
  if (runSignal.aborted) throw new Error("Research run cancelled.");
  if (!destination) throw new Error("Google did not reveal this result's destination URL.");
  let url: URL;
  try { url = new URL(destination, result.url); }
  catch { throw new Error("Google returned an invalid result destination URL."); }
  if (!/^https?:$/.test(url.protocol) || isGoogleHost(url.hostname)) throw new Error("Google did not reveal an external result URL.");
  return { ...result, url: url.href, domain: url.hostname.replace(/^www\./, "") };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function startResearch(query: SearchQuery, results: SearchResult[], tabId: number, runId: string, modeOverride?: ScoringMode, scorerIdsOverride?: string[]): Promise<void> {
  if (!query?.text.trim() || !Array.isArray(results) || !results.length) return;
  const scoringSettingsSnapshot = readScoringSettings();
  const settings = await scoringSettingsSnapshot;
  const recentMode = await readRecentScoringMode();
  const mode: ScoringMode = modeOverride ?? recentMode ?? settings.model;
  activeAbortController?.abort();
  const unique = results.filter((result, index, all) => researchHostOrigins([result.url]).length > 0 && all.findIndex((other) => other.url === result.url) === index).slice(0, 20);
  if (!unique.length) return;
  const run = createResearchRun(runId, query, unique);
  run.scoring = { mode, selectedScorerIds: [], successfulScorerIds: [], failedScorerIds: [], fusion: { type: "rrf", k: 60, weights: {} } };
  const controller = new AbortController();
  activeAbortController = controller;
  currentRunId = run.runId;
  currentRun = run;
  activeTabId = tabId;
  await chrome.storage.session.set({ [SESSION_TAB_KEY]: tabId });
  sendUpdate(run);

  const resolved = await mapWithConcurrency(unique, MAX_CONCURRENCY, async (result) => {
    try { return { result: await resolveGoogleGotoResult(result, controller.signal) }; }
    catch (error) { return { result, error: error instanceof Error ? error.message : "Could not resolve this Google result." }; }
  });
  if (currentRunId !== run.runId || controller.signal.aborted) return;
  resolved.forEach((outcome, index) => {
    const source = run.sources[index];
    source.result = outcome.result;
    if (outcome.error) {
      source.status = "failed";
      source.error = outcome.error;
    }
  });
  sendUpdate(run);

  const requiredHostOrigins = researchHostOrigins(run.sources.filter((source) => source.status !== "failed").map(({ result }) => result.url));
  if (!requiredHostOrigins.length) {
    run.status = "failed";
    activeAbortController = null;
    sendUpdate(run);
    return;
  }
  let granted: boolean;
  try {
    granted = await hasResearchHostPermission(chrome.permissions, requiredHostOrigins);
  } catch (error) {
    if (currentRunId !== run.runId) return;
    run.status = "failed";
    run.hostPermissionNeeded = true;
    run.hostPermissionOrigins = requiredHostOrigins;
    run.sources.filter((source) => source.status !== "failed").forEach((source) => { source.status = "failed"; source.error = error instanceof Error ? error.message : "Could not check page access."; });
    activeAbortController = null;
    sendUpdate(run);
    return;
  }
  if (currentRunId !== run.runId) return;
  if (!granted) {
    run.status = "failed";
    run.hostPermissionNeeded = true;
    run.hostPermissionOrigins = requiredHostOrigins;
    run.sources.filter((source) => source.status !== "failed").forEach((source) => { source.status = "failed"; source.error = "Page access is needed to read this result."; });
    activeAbortController = null;
    sendUpdate(run);
    return;
  }
  run.hostPermissionNeeded = false;
  run.hostPermissionOrigins = undefined;
  sendUpdate(run);

  const available = await availableDecisionScorerIds(settings);
  let selectedIds: string[];
  if (scorerIdsOverride?.length) {
    selectedIds = [...new Set(scorerIdsOverride)];
    if (selectedIds.some((id) => id !== "mock" && !available.includes(id))) throw new Error("One or more scorers from the previous run are no longer available. Choose an available scorer from the Google menu.");
  } else if (mode === "consensus") {
    selectedIds = available;
    if (selectedIds.length < 2) throw new Error("Consensus needs at least two configured decision models.");
  } else if (mode === "auto") {
    selectedIds = available.includes("jev") ? ["jev"] : ["mock"];
  } else if (mode === "mock") {
    selectedIds = ["mock"];
  } else {
    selectedIds = [mode];
    if (!available.includes(mode)) throw new Error(unavailableModelReason(mode, settings));
  }
  const scorers = await Promise.all(selectedIds.map((id) => makeScorer(id, settings)));
  run.scoring.selectedScorerIds = selectedIds;
  run.scoring.fusion.weights = Object.fromEntries(selectedIds.map((id) => [id, 1]));

  await processResearchRun(
    run,
    { load: (result, setStage) => loadSource(result, setStage, controller.signal) },
    scorers,
    sendUpdate,
    () => currentRunId === run.runId,
    { concurrency: MAX_CONCURRENCY, perPageCandidateLimit: 16, signal: controller.signal }
  );
  if (currentRunId === run.runId) {
    activeAbortController = null;
    sendUpdate(run);
  }
}

async function availableDecisionScorerIds(settings?: Awaited<ReturnType<typeof readScoringSettings>>): Promise<string[]> {
  settings ??= await readScoringSettings();
  const available: string[] = [];
  if (settings.cloudflareWorkerUrl) {
    try {
      const endpoint = new URL(settings.cloudflareWorkerUrl);
      if (await chrome.permissions.contains({ origins: [`${endpoint.origin}/*`] })) available.push("clef-flash", "clef");
    } catch { /* Invalid or unavailable Worker configuration is omitted from the chooser. */ }
  }
  if (await readJevApiKey() && await chrome.permissions.contains({ origins: ["https://api.typesafe.ai/*"] })) available.push("jev");
  return available;
}

function unavailableModelReason(model: string, settings: Awaited<ReturnType<typeof readScoringSettings>>): string {
  if ((model === "clef" || model === "clef-flash") && !settings.cloudflareWorkerUrl) return "Set up the Scoring Worker in Scry Settings before choosing Clef.";
  if (model === "jev") return "Jev needs a saved API key and TypeSafe API access. Set these up in Scry Settings.";
  return "This scoring model is unavailable.";
}

async function makeScorer(id: string, settings?: Awaited<ReturnType<typeof readScoringSettings>>): Promise<PassageScorer> {
  settings ??= await readScoringSettings();
  if (id === "mock") return new MockPassageScorer();
  if (id === "clef" || id === "clef-flash") return new CloudflareClefScorer(id, new CloudflareClefHttpTransport(settings.cloudflareWorkerUrl));
  if (id === "jev") {
    const key = await readJevApiKey();
    if (!key) throw new Error(unavailableModelReason(id, settings));
    return new JevPassageScorer(new TypeSafeJevTransport(key));
  }
  throw new Error(`Unknown scoring model: ${id}`);
}

function queryFromUrl(rawUrl?: string): string {
  try { return new URL(rawUrl ?? "").searchParams.get("q")?.trim().toLowerCase().replace(/\s+/g, " ") ?? ""; }
  catch { return ""; }
}

async function cancelRun(): Promise<void> {
  if (!currentRun || !currentRunId) return;
  activeAbortController?.abort();
  activeAbortController = null;
  currentRunId = null;
  currentRun.status = "cancelled";
  if (currentRun.scoring) delete currentRun.scoring.addingScorers;
  sendUpdate(currentRun);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId || !changeInfo.url || !currentRun) return;
  const next = queryFromUrl(changeInfo.url);
  if (next !== currentRun.query.normalized) {
    activeTabId = null;
    void chrome.storage.session.remove(SESSION_TAB_KEY);
    void cancelRun();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPEN_EVIDENCE_AT_SOURCE") {
    const payload = message as { runId: string; passageId: string };
    void openEvidenceAtSource(payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ handled: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "START_RESEARCH") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") { sendResponse({ ok: false, error: "Could not identify the Google tab." }); return; }
    void chrome.sidePanel.setOptions({ tabId, path: "sidepanel/index.html", enabled: true });
    void chrome.sidePanel.open({ tabId }).catch(() => undefined);
    // Retain the originating tab so the side panel can rerun after a permission decision.
    const runId = crypto.randomUUID();
    const mode = typeof message.scoringMode === "string" ? message.scoringMode as ScoringMode : undefined;
    void startResearch(message.query as SearchQuery, message.results as SearchResult[], tabId, runId, mode).catch((error) => {
      if (currentRun && currentRunId === runId) {
        currentRun.status = "failed";
        const failure = error instanceof Error ? error.message : String(error);
        for (const source of currentRun.sources) {
          if (source.status !== "complete" && source.status !== "failed") {
            source.status = "failed";
            source.error = failure;
          }
        }
        currentRun.scoring ??= { mode: "auto", selectedScorerIds: [], successfulScorerIds: [], failedScorerIds: [], fusion: { type: "rrf", k: 60, weights: {} } };
        currentRun.scoring.failedScorerIds = currentRun.scoring.selectedScorerIds.filter((id) => !currentRun?.scoring?.successfulScorerIds.includes(id));
        activeAbortController?.abort();
        activeAbortController = null;
        sendUpdate(currentRun);
      }
    });
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "GET_RUN") {
    void (async () => {
      if (!currentRun) await restoreRunFromSession();
      return currentRun;
    })().then((run) => sendResponse({ run: run ? panelSnapshot(run) : null }));
    return true;
  }
  if (message?.type === "CANCEL_RESEARCH") {
    void cancelRun().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "RERUN_RESEARCH") {
    void (async () => {
      if (!currentRun) {
        await restoreRunFromSession();
      }
      if (!currentRun || activeTabId === null || !currentRun.sources.length) {
        sendResponse({ ok: false, error: "There are no current search results to research." });
        return;
      }
      const query = currentRun.query;
      const results = currentRun.sources.map(({ result }) => result);
      const tabId = activeTabId;
      const mode = currentRun.scoring?.mode as ScoringMode | undefined;
      const scorerIds = currentRun.scoring?.selectedScorerIds;
      void startResearch(query, results, tabId, crypto.randomUUID(), mode, scorerIds).catch((error) => {
        if (!currentRun || currentRunId !== currentRun.runId) return;
        currentRun.status = "failed";
        currentRun.scoring ??= { mode: "auto", selectedScorerIds: [], successfulScorerIds: [], failedScorerIds: [], fusion: { type: "rrf", k: 60, weights: {} } };
        currentRun.scoring.failedScorerIds = currentRun.scoring.selectedScorerIds.filter((id) => !currentRun?.scoring?.successfulScorerIds.includes(id));
        sendUpdate(currentRun);
      });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "GET_SCORING_CHOICES") {
    void (async () => {
      const [settings, recent] = await Promise.all([readScoringSettings(), readRecentScoringMode()]);
      const available = await availableDecisionScorerIds(settings);
      const defaultMode = recent ?? settings.model;
      const models = [
        { id: "clef-flash", label: "Clef Flash", available: available.includes("clef-flash") },
        { id: "clef", label: "Clef", available: available.includes("clef") },
        { id: "jev", label: "Jev", available: available.includes("jev") }
      ];
      return { models, consensusAvailable: available.length >= 2, defaultMode };
    })().then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "SET_SCORING_MODE") {
    const mode = message.mode as ScoringMode;
    if (!["auto", "mock", "jev", "clef-flash", "clef", "consensus"].includes(mode)) {
      sendResponse({ ok: false, error: "Unknown scoring mode." });
      return;
    }
    void saveRecentScoringMode(mode).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "ADD_SCORERS") {
    let addRunId: string | null = null;
    let addPreviousStatus: ResearchRun["status"] = "complete";
    void (async () => {
      if (!currentRun) {
        await restoreRunFromSession();
      }
      const run = currentRun;
      if (!run?.candidateSet?.frozen || !run.candidateSet.candidates.length || !run.scoring || (run.status !== "complete" && run.status !== "cancelled") || run.scoring.addingScorers?.length) return { ok: false, error: "Frozen candidates are unavailable for adding a model in this session." };
      const requested = Array.isArray(message.scorerIds) ? message.scorerIds.filter((id: unknown) => typeof id === "string") as string[] : [];
      const available = await availableDecisionScorerIds();
      const existing = new Set(run.scoring.successfulScorerIds);
      const ids = [...new Set(requested)].filter((id) => available.includes(id) && !existing.has(id));
      if (!ids.length) return { ok: false, error: "Choose an available scorer that has not already scored this run." };
      const controller = new AbortController();
      activeAbortController?.abort();
      activeAbortController = controller;
      currentRunId = run.runId;
      addRunId = run.runId;
      addPreviousStatus = run.status;
      run.status = "running";
      run.scoring.addingScorers = ids;
      const selectedBeforeAdd = run.scoring.selectedScorerIds.filter((id) => run.scoring?.mode === "mock" || id !== "mock");
      run.scoring.selectedScorerIds = [...new Set([...selectedBeforeAdd, ...ids])];
      sendUpdate(run);
      const settings = await readScoringSettings();
      const results = await Promise.all(ids.map(async (id) => {
        try {
          const scorer = await makeScorer(id, settings);
          const result = await scoreFrozenCandidates(run, scorer, controller.signal, () => currentRunId === run.runId);
          if (result.error) throw new Error(result.error);
          return { id };
        } catch (error) {
          return { id, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      if (currentRunId !== run.runId) return { ok: false, error: "Scoring was cancelled." };
      const failedIds = results.filter((result) => "error" in result).map(({ id }) => id);
      run.scoring.failedScorerIds = [...new Set([...run.scoring.failedScorerIds.filter((id) => !ids.includes(id)), ...failedIds])];
      const selectedDecisionIds = run.scoring.selectedScorerIds.filter((id) => id !== "mock");
      if (selectedDecisionIds.length >= 2 && available.every((id) => selectedDecisionIds.includes(id))) run.scoring.mode = "consensus";
      delete run.scoring.addingScorers;
      run.status = addPreviousStatus;
      applyRunRanking(run);
      activeAbortController = null;
      sendUpdate(run);
      return { ok: true };
    })().then(sendResponse).catch((error) => {
      if (addRunId && currentRun?.runId === addRunId && currentRunId === addRunId && currentRun.scoring) {
        delete currentRun.scoring.addingScorers;
        currentRun.status = addPreviousStatus;
        activeAbortController = null;
        sendUpdate(currentRun);
      }
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message?.type === "QUERY_CHANGED") {
    if (currentRun && message.query !== currentRun.query.normalized) {
      activeTabId = null;
      void chrome.storage.session.remove(SESSION_TAB_KEY);
      void cancelRun();
    }
    sendResponse({ ok: true });
    return;
  }
});
