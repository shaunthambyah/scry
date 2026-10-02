import type { ResearchRunView, ScoredPassage, SourceLifecycle, SourceProgress, SourceScore } from "../models/types.js";
import { EVIDENCE_DISPLAY_CONFIG, relevancePercent, selectEvidenceForDisplay } from "../ranking/evidencePolicy.js";
import { requestResearchHostPermission, researchHostOrigins } from "../background/hostPermissions.js";
import { evidenceTextFragmentUrl } from "./evidenceNavigation.js";
import { evidenceCoverageSegments } from "./coverageMap.js";

const queryEl = document.querySelector<HTMLElement>("#query")!;
const provenanceEl = document.querySelector<HTMLDetailsElement>("#provenance")!;
const faviconStackEl = document.querySelector<HTMLElement>("#favicon-stack")!;
const statusSummaryEl = document.querySelector<HTMLElement>("#status-summary")!;
const countsEl = document.querySelector<HTMLElement>("#counts")!;
const progressTrackEl = document.querySelector<HTMLElement>("#progress-track")!;
const progressBarEl = document.querySelector<HTMLElement>("#progress-bar")!;
const sourceStatusListEl = document.querySelector<HTMLElement>("#source-status-list")!;
const groupedEl = document.querySelector<HTMLElement>("#grouped-view")!;
const passagesEl = document.querySelector<HTMLElement>("#passages-view")!;
const rerunButton = document.querySelector<HTMLButtonElement>("#rerun")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const scoringStatusEl = document.querySelector<HTMLElement>("#scoring-status")!;
const addModelEl = document.querySelector<HTMLDetailsElement>("#add-model")!;
const addModelOptionsEl = document.querySelector<HTMLElement>("#add-model-options")!;
const addModelSubmitEl = document.querySelector<HTMLButtonElement>("#add-model-submit")!;
let activeView: "grouped" | "passages" = "grouped";
let currentRun: ResearchRunView | null = null;
let renderedRunId: string | null = null;
let previousRunStatus: ResearchRunView["status"] | null = null;
let visiblePassageLimit = EVIDENCE_DISPLAY_CONFIG.initialLimit;
let expandedSources = new Set<string>();
let selectedPassageId: string | null = null;
let scorerChoices: Array<{ id: string; label: string; available: boolean }> = [];
let consensusAvailable = false;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function selectPassage(passageId: string): void {
  selectedPassageId = passageId;
  for (const element of document.querySelectorAll<HTMLElement>(".coverage-segment")) {
    let ids: string[] = [];
    try { ids = JSON.parse(element.dataset.passageIds ?? "[]") as string[]; } catch { /* Ignore malformed generated markup. */ }
    element.classList.toggle("selected", ids.includes(passageId));
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-passage-id]")) {
    element.classList.toggle("selected", element.dataset.passageId === passageId);
  }
}

function sourceUrl(source: SourceProgress): string {
  return source.document?.url ?? source.result.url;
}

function faviconUrl(source: SourceProgress): string | undefined {
  if (source.document?.faviconUrl) return source.document.faviconUrl;
  try { return new URL("/favicon.ico", sourceUrl(source)).href; }
  catch { return undefined; }
}

function appendFavicon(target: HTMLElement, source: SourceProgress): HTMLElement {
  const icon = make("span", "favicon");
  icon.title = source.document?.domain ?? source.result.domain;
  const fallback = make("span", "favicon-fallback", "◉");
  fallback.setAttribute("aria-hidden", "true");
  icon.append(fallback);
  const url = faviconUrl(source);
  if (url) {
    const image = make("img");
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => icon.classList.add("fallback"), { once: true });
    image.src = url;
    icon.append(image);
  } else {
    icon.classList.add("fallback");
  }
  target.append(icon);
  return icon;
}

function evidenceAnchor(item: ScoredPassage, runId: string, className: string): HTMLAnchorElement {
  const anchor = make("a", className);
  anchor.href = evidenceTextFragmentUrl(item.passage.url, item.passage);
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    selectPassage(item.passage.id);
    event.preventDefault();
    const openNormally = () => {
      try { void chrome.tabs.create({ url: anchor.href, active: true }).catch(() => undefined); }
      catch { window.open(anchor.href, "_blank", "noopener"); }
    };
    void chrome.runtime.sendMessage<{ handled?: boolean }>({
      type: "OPEN_EVIDENCE_AT_SOURCE",
      runId,
      passageId: item.passage.id
    }).then((response) => {
      if (!response?.handled) openNormally();
    }).catch(openNormally);
  });
  return anchor;
}

function passageRank(item: ScoredPassage, fallbackRanks: Map<string, number>): number {
  return item.globalRank ?? fallbackRanks.get(item.passage.id) ?? 0;
}

function rankLabel(rank: number): HTMLElement {
  const label = make("span", `passage-rank${rank === 1 ? " top-ranked" : ""}`, `#${rank} overall`);
  return label;
}

function passageHeading(item: ScoredPassage): string | undefined {
  const heading = item.passage.headingPath.at(-1)?.replace(/\s+/g, " ").trim();
  return heading || undefined;
}

function createPassageContent(item: ScoredPassage, rank: number, hidden = false): HTMLElement {
  const block = make("article", `dossier-passage${selectedPassageId === item.passage.id ? " selected" : ""}`);
  block.dataset.passageId = item.passage.id;
  block.id = `global-passage-${rank}`;
  block.tabIndex = -1;
  block.hidden = hidden;
  const head = make("div", "passage-head");
  head.append(rankLabel(rank));
  if (!isFusedRun(currentRun)) head.append(make("span", "match", `${relevancePercent(item.relevance)}%`));
  block.append(head);
  const heading = passageHeading(item);
  if (heading) block.append(make("h4", "passage-heading", heading));
  const text = evidenceAnchor(item, currentRun?.runId ?? "", "passage-text");
  text.textContent = item.passage.text;
  block.append(text);
  return block;
}

function isFusedRun(run: ResearchRunView | null): boolean {
  return (run?.scoring?.successfulScorerIds.length ?? 0) > 1;
}

function displayedScorers(run: ResearchRunView): string[] {
  const successful = run.scoring?.successfulScorerIds ?? [];
  const real = successful.filter((id) => id !== "mock");
  return real.length ? real : successful;
}

function scorerLabel(id: string): string {
  return id === "clef-flash" ? "Clef Flash" : id === "jev" ? "Jev" : id === "mock" ? "Local scorer" : id === "clef" ? "Clef" : id;
}

function sourceSectionsLabel(passages: ScoredPassage[]): string {
  return `${passages.length} relevant passage${passages.length === 1 ? "" : "s"}`;
}

function scrollToPassage(run: ResearchRunView, sourceId: string, rank: number): void {
  const targetId = `global-passage-${rank}`;
  let target = document.getElementById(targetId);
  if (!target || (target instanceof HTMLElement && target.hidden)) {
    expandedSources.add(sourceId);
    render(run);
    target = document.getElementById(targetId);
  }
  if (!(target instanceof HTMLElement)) return;
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
  target.classList.add("highlight");
  window.setTimeout(() => target?.classList.remove("highlight"), 950);
}

function renderCoverageMap(source: SourceProgress, passages: ScoredPassage[], fallbackRanks: Map<string, number>): HTMLElement | null {
  if (!passages.length) return null;
  const map = make("div", "coverage-map");
  map.setAttribute("role", "group");
  map.setAttribute("aria-label", `Document coverage from start to finish for ${source.document?.title ?? source.result.title}`);
  const documentLength = source.document?.documentLength ?? source.document?.sourceText.length ?? 0;
  const segments = evidenceCoverageSegments(passages, documentLength, source.rawPassageCount);
  for (const segment of segments) {
    const item = passages.find(({ passage }) => passage.id === segment.primaryPassageId);
    if (!item) continue;
    const rank = segment.globalRank || passageRank(item, fallbackRanks);
    const percent = isFusedRun(currentRun) ? null : relevancePercent(segment.relevance);
    const button = make("button", `coverage-segment${segment.passageIds.includes(selectedPassageId ?? "") ? " selected" : ""}`);
    button.type = "button";
    button.style.left = `${segment.start * 100}%`;
    button.style.width = `${segment.width * 100}%`;
    button.dataset.passageIds = JSON.stringify(segment.passageIds);
    button.dataset.positionMethod = segment.positionMethod;
    const mergedLabel = segment.passageIds.length > 1 ? ` · ${segment.passageIds.length} passages` : "";
    button.title = percent === null ? `#${rank} overall${mergedLabel}` : `#${rank} overall · ${percent}% match${mergedLabel}`;
    button.setAttribute("aria-label", `Passage #${rank} overall${percent === null ? "" : `, ${percent}% match`}, document section from ${Math.round(segment.start * 100)}% to ${Math.round(segment.end * 100)}%${mergedLabel}`);
    button.addEventListener("click", () => {
      selectPassage(segment.primaryPassageId);
      if (currentRun) scrollToPassage(currentRun, source.result.id, rank);
    });
    map.append(button);
  }
  return map;
}

function renderDossier(sourceScore: SourceScore, passages: ScoredPassage[], fallbackRanks: Map<string, number>): HTMLElement | null {
  const run = currentRun;
  const source = run?.sources.find(({ result }) => result.id === sourceScore.sourceId);
  if (!run || !source || !passages.length) return null;

  const dossier = make("article", "source-dossier");
  dossier.setAttribute("aria-label", `Source rank ${sourceScore.researchRank}: ${source.document?.domain ?? source.result.domain}`);
  dossier.append(make("h2", "dossier-rank", String(sourceScore.researchRank).padStart(2, "0")));
  const body = make("div", "dossier-body");
  const sourceLink = make("a", "source-link");
  sourceLink.href = sourceUrl(source);
  sourceLink.target = "_blank";
  sourceLink.rel = "noreferrer";
  sourceLink.setAttribute("aria-label", `Open ${source.document?.domain ?? source.result.domain}`);
  appendFavicon(sourceLink, source);
  sourceLink.append(make("span", "source-domain", source.document?.domain ?? source.result.domain), make("span", "external-mark", "↗"));
  const top = make("div", "dossier-source");
  top.append(sourceLink);
  body.append(top);

  const title = source.document?.title ?? source.result.title;
  const titleHeading = make("h3", "dossier-title");
  const titleLink = make("a", "dossier-title-link", title);
  titleLink.href = sourceUrl(source);
  titleLink.target = "_blank";
  titleLink.rel = "noreferrer";
  titleLink.title = title;
  titleHeading.append(titleLink);
  body.append(titleHeading);

  const stats = make("div", "dossier-stats");
  stats.append(
    make("span", "dossier-best", isFusedRun(run) ? `#${passageRank(sourceScore.topPassage, fallbackRanks)} consensus` : `${relevancePercent(sourceScore.topPassage.relevance)}% best match`),
    make("span", undefined, sourceSectionsLabel(passages)),
    make("span", undefined, `Google #${sourceScore.googleRank}`)
  );
  body.append(stats);

  const map = renderCoverageMap(source, passages, fallbackRanks);
  if (map) body.append(map);
  const sorted = [...passages].sort((a, b) => passageRank(a, fallbackRanks) - passageRank(b, fallbackRanks));
  const thirdIsClose = !isFusedRun(run) && sorted.length > 2 && sorted[0].relevance - sorted[2].relevance <= 0.05;
  const defaultVisibleCount = Math.min(sorted.length, thirdIsClose ? 3 : 2);
  const expanded = expandedSources.has(source.result.id);
  const shownCount = expanded ? sorted.length : defaultVisibleCount;
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    body.append(createPassageContent(item, passageRank(item, fallbackRanks), index >= shownCount));
  }
  if (sorted.length > defaultVisibleCount) {
    const remaining = sorted.length - defaultVisibleCount;
    const moreLabel = `+ ${remaining} more ${remaining === 1 ? "passage" : "passages"}`;
    const button = make("button", "expand-source", expanded ? "Show fewer passages" : moreLabel);
    button.type = "button";
    button.setAttribute("aria-expanded", String(expanded));
    button.addEventListener("click", () => {
      if (expandedSources.has(source.result.id)) expandedSources.delete(source.result.id);
      else expandedSources.add(source.result.id);
      render(run);
    });
    body.append(button);
  }
  dossier.append(body);
  return dossier;
}

function renderGrouped(run: ResearchRunView, evidence: ScoredPassage[], sourceScores: SourceScore[], fallbackRanks: Map<string, number>): void {
  const bySource = new Map<string, ScoredPassage[]>();
  for (const item of evidence) {
    const group = bySource.get(item.passage.sourceId) ?? [];
    group.push(item);
    bySource.set(item.passage.sourceId, group);
  }
  const dossiers = sourceScores.flatMap((score) => {
    const rendered = renderDossier(score, bySource.get(score.sourceId) ?? [], fallbackRanks);
    return rendered ? [rendered] : [];
  });
  if (dossiers.length) groupedEl.replaceChildren(...dossiers);
  else if (run.hostPermissionNeeded) renderPermissionHelp(groupedEl);
  else renderEmpty(groupedEl, run.status === "running" ? "Sources and evidence are appearing as pages finish." : "No useful passages were found in these results.");
}

function renderGlobalPassage(item: ScoredPassage, source: SourceProgress, rank: number, runId: string): HTMLElement {
  const result = make("article", `global-passage${selectedPassageId === item.passage.id ? " selected" : ""}`);
  result.dataset.passageId = item.passage.id;
  const head = make("div", "passage-head");
  head.append(rankLabel(rank));
  if (!isFusedRun(currentRun)) head.append(make("span", "match", `${relevancePercent(item.relevance)}%`));
  result.append(head);
  const sourceRow = make("div", "global-source");
  const link = make("a", "source-link");
  link.href = sourceUrl(source);
  link.target = "_blank";
  link.rel = "noreferrer";
  appendFavicon(link, source);
  link.append(make("span", "source-domain", source.document?.domain ?? source.result.domain), make("span", "external-mark", "↗"));
  link.setAttribute("aria-label", `Open passage at ${source.document?.domain ?? source.result.domain}`);
  sourceRow.append(link);
  const title = make("a", "global-title", source.document?.title ?? source.result.title);
  title.href = sourceUrl(source);
  title.target = "_blank";
  title.rel = "noreferrer";
  title.title = source.document?.title ?? source.result.title;
  sourceRow.append(title);
  result.append(sourceRow);
  const heading = passageHeading(item);
  if (heading) result.append(make("h4", "passage-heading", heading));
  const text = evidenceAnchor(item, runId, "passage-text");
  text.textContent = item.passage.text;
  result.append(text);
  const meta = make("div", "result-meta", `Google #${source.result.googleRank}`);
  if (isFusedRun(currentRun)) meta.append(make("span", undefined, `${item.scorerCount ?? 0}/${currentRun?.scoring?.successfulScorerIds.length ?? 0} models`));
  result.append(meta);
  return result;
}

function renderPassages(run: ResearchRunView, evidence: ScoredPassage[], fallbackRanks: Map<string, number>): void {
  const visible = evidence.slice(0, visiblePassageLimit);
  const rows: HTMLElement[] = [];
  for (const item of visible) {
    const source = run.sources.find(({ result }) => result.id === item.passage.sourceId);
    if (source) rows.push(renderGlobalPassage(item, source, passageRank(item, fallbackRanks), run.runId));
  }
  if (!rows.length) {
    if (run.hostPermissionNeeded) renderPermissionHelp(passagesEl);
    else renderEmpty(passagesEl, run.status === "running" ? "Waiting for useful passages to finish scoring…" : "No useful passages were found in these results.");
    return;
  }
  if (evidence.length > visiblePassageLimit) {
    const more = make("button", "show-more", `Show more (${evidence.length - visiblePassageLimit})`);
    more.type = "button";
    more.addEventListener("click", () => {
      visiblePassageLimit += EVIDENCE_DISPLAY_CONFIG.initialLimit;
      if (currentRun) render(currentRun);
    });
    rows.push(more);
  }
  passagesEl.replaceChildren(...rows);
}

function orderedSuccessfulSources(run: ResearchRunView): SourceProgress[] {
  const ranks = new Map(run.sourceScores.map((score) => [score.sourceId, score.researchRank]));
  return run.sources.filter((source) => source.status === "complete" && source.document)
    .sort((a, b) => (ranks.get(a.result.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.result.id) ?? Number.MAX_SAFE_INTEGER) || a.result.googleRank - b.result.googleRank);
}

function renderFaviconStack(run: ResearchRunView): void {
  const successful = orderedSuccessfulSources(run);
  const visible = successful.slice(0, EVIDENCE_DISPLAY_CONFIG.provenanceFaviconLimit);
  const icons = visible.map((source) => {
    const wrapper = make("span", "favicon-stack-item");
    appendFavicon(wrapper, source);
    return wrapper;
  });
  if (successful.length > visible.length) icons.push(make("span", "favicon-overflow", `+${successful.length - visible.length}`));
  faviconStackEl.replaceChildren(...icons);
}

function statusGlyph(status: SourceLifecycle): string {
  if (status === "complete") return "✓";
  if (status === "failed") return "×";
  if (status === "queued") return "·";
  return "⟳";
}

function renderStatusDetails(run: ResearchRunView): void {
  const rows = run.sources.map((source) => {
    const row = make("div", `status-row ${source.status}`);
    if (source.status === "complete" && source.document) appendFavicon(row, source);
    else row.append(make("span", "status-icon", statusGlyph(source.status)));
    row.append(make("span", "status-domain", source.document?.domain ?? source.result.domain));
    const detail = source.status === "complete" ? `${source.rawPassageCount} passages` : source.status === "failed" ? source.error ?? "Unavailable" : source.status;
    row.append(make("span", "status-detail", detail));
    return row;
  });
  sourceStatusListEl.replaceChildren(...rows);
}

function renderProvenance(run: ResearchRunView, visibleEvidenceCount: number): void {
  provenanceEl.hidden = false;
  renderFaviconStack(run);
  renderStatusDetails(run);
  const done = run.sources.filter((source) => source.status === "complete" || source.status === "failed").length;
  const total = run.sources.length;
  const failed = run.sources.filter((source) => source.status === "failed").length;
  const plural = (count: number, singular: string) => `${count} ${singular}${count === 1 ? "" : "s"}`;
  if (run.status === "running") {
    statusSummaryEl.textContent = `Researching ${done} of ${total} sources`;
    countsEl.textContent = visibleEvidenceCount ? plural(visibleEvidenceCount, "passage") : "";
  } else if (run.status === "queued") {
    statusSummaryEl.textContent = `Starting ${plural(total, "source")}`;
    countsEl.textContent = "";
  } else if (run.status === "complete") {
    statusSummaryEl.textContent = plural(total, "source");
    countsEl.textContent = `${plural(visibleEvidenceCount, "passage")}${failed ? ` · ${plural(failed, "unavailable")}` : ""}`;
  } else if (run.status === "cancelled") {
    statusSummaryEl.textContent = "Research cancelled";
    countsEl.textContent = visibleEvidenceCount ? plural(visibleEvidenceCount, "passage") : "";
  } else if (run.hostPermissionNeeded) {
    statusSummaryEl.textContent = "Page access needed";
    countsEl.textContent = "Choose Allow page access to continue";
  } else {
    statusSummaryEl.textContent = "Research could not start";
    countsEl.textContent = failed ? plural(failed, "unavailable") : "";
  }
  if (run.scoring?.addingScorers?.length) {
    statusSummaryEl.textContent = "Adding model rankings";
    countsEl.textContent = visibleEvidenceCount ? plural(visibleEvidenceCount, "passage") : "";
  }
  const summary = provenanceEl.querySelector("summary")!;
  summary.setAttribute("aria-label", `${statusSummaryEl.textContent}${countsEl.textContent ? `, ${countsEl.textContent}` : ""}. Expand source details.`);
  const running = run.status === "running" || run.status === "queued";
  progressTrackEl.hidden = !running;
  progressTrackEl.setAttribute("aria-valuemax", String(total));
  progressTrackEl.setAttribute("aria-valuenow", String(done));
  progressBarEl.style.width = `${total ? Math.round(done / total * 100) : 0}%`;
  const successful = displayedScorers(run);
  const selectedRaw = run.scoring?.selectedScorerIds ?? [];
  const selected = successful.some((id) => id !== "mock") ? selectedRaw.filter((id) => id !== "mock") : selectedRaw;
  const adding = run.scoring?.addingScorers ?? [];
  if (adding.length) scoringStatusEl.textContent = `Adding ${adding.map(scorerLabel).join(" + ")}…`;
  else if (successful.length > 1) {
    const completeEnsemble = run.scoring?.mode === "consensus" || selected.length === scorerChoices.filter((choice) => choice.available).length;
    const summary = `${successful.length}${selected.length > successful.length ? `/${selected.length}` : ""} models`;
    scoringStatusEl.textContent = `${completeEnsemble ? "Consensus · " : ""}${summary}${run.scoring?.failedScorerIds.length ? " · incomplete" : ""}`;
  }
  else if (successful.length === 1) scoringStatusEl.textContent = `Scored with ${scorerLabel(successful[0])}${selected.length > 1 ? ` · 1/${selected.length} models` : ""}${run.scoring?.failedScorerIds.length ? " · incomplete" : ""}`;
  else if (run.scoring?.failedScorerIds.length) scoringStatusEl.textContent = "Scoring unavailable";
  else scoringStatusEl.textContent = "";
  const successfulIds = new Set(run.scoring?.successfulScorerIds ?? []);
  const availableToAdd = scorerChoices.filter((choice) => choice.available && !successfulIds.has(choice.id));
  addModelEl.hidden = !run.canAddModels || !availableToAdd.length || Boolean(adding.length) || (run.status !== "complete" && run.status !== "cancelled");
  const checked = new Set([...addModelOptionsEl.querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value));
  addModelOptionsEl.replaceChildren(...availableToAdd.map((choice) => {
    const label = make("label", "add-model-option");
    const input = make("input");
    input.type = "checkbox";
    input.value = choice.id;
    input.checked = checked.has(choice.id);
    input.disabled = adding.includes(choice.id);
    input.addEventListener("change", () => {
      addModelSubmitEl.disabled = Boolean(run.scoring?.addingScorers?.length) || !addModelOptionsEl.querySelector("input:checked");
    });
    label.append(input, document.createTextNode(choice.label));
    return label;
  }));
  addModelSubmitEl.disabled = adding.length > 0 || !addModelOptionsEl.querySelector("input:checked");
}

function render(run: ResearchRunView | null): void {
  const newRun = Boolean(run && run.runId !== renderedRunId);
  const preserveScroll = Boolean(run && run.runId === renderedRunId);
  const oldScrollY = window.scrollY;
  currentRun = run;
  if (!run) {
    renderedRunId = null;
    previousRunStatus = null;
    activeView = "grouped";
    expandedSources.clear();
    selectedPassageId = null;
    provenanceEl.hidden = true;
    queryEl.hidden = true;
    queryEl.textContent = "";
    countsEl.textContent = "";
    statusSummaryEl.textContent = "";
    faviconStackEl.replaceChildren();
    sourceStatusListEl.replaceChildren();
    progressBarEl.style.width = "0";
    rerunButton.disabled = true;
    cancelButton.hidden = true;
    for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
      const selected = tab.dataset.view === "grouped";
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
    }
    groupedEl.hidden = false;
    passagesEl.hidden = true;
    renderEmpty(groupedEl, "Search Google, then choose “Research these results”.");
    renderEmpty(passagesEl, "The global passage ranking will appear here.");
    return;
  }

  if (newRun) {
    renderedRunId = run.runId;
    activeView = "grouped";
    expandedSources = new Set();
    selectedPassageId = null;
    visiblePassageLimit = EVIDENCE_DISPLAY_CONFIG.initialLimit;
    provenanceEl.open = run.status === "queued" || run.status === "running";
  } else if (run.status === "complete" && previousRunStatus !== "complete") {
    provenanceEl.open = false;
  }
  queryEl.hidden = false;
  queryEl.textContent = run.query.text;
  rerunButton.disabled = run.sources.length === 0;
  rerunButton.setAttribute("aria-label", run.hostPermissionNeeded ? "Allow page access and retry" : "Rerun current results");
  rerunButton.title = run.hostPermissionNeeded ? "Allow page access and retry" : "Rerun current results";
  cancelButton.hidden = run.status !== "running" && run.status !== "queued";

  const allEvidence = selectEvidenceForDisplay(run.evidence, run.sources);
  const globalRanks = new Map(allEvidence.map((item, index) => [item.passage.id, item.globalRank ?? index + 1]));
  renderProvenance(run, allEvidence.length);
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    const selected = tab.dataset.view === activeView;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.setAttribute("tabindex", selected ? "0" : "-1");
  }
  groupedEl.hidden = activeView !== "grouped";
  passagesEl.hidden = activeView !== "passages";
  renderGrouped(run, allEvidence, run.sourceScores, globalRanks);
  renderPassages(run, allEvidence, globalRanks);
  previousRunStatus = run.status;
  if (preserveScroll && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => window.scrollTo({ top: oldScrollY, behavior: "auto" }));
  }
}

function renderEmpty(target: HTMLElement, message: string): void {
  target.replaceChildren(make("div", "empty", message));
}

function requestPageAccessAndRetry(button: HTMLButtonElement): void {
  // Invoke permissions.request in the click handler so Chrome retains the user gesture.
  button.disabled = true;
  let request: Promise<boolean>;
  try {
    const origins = currentRun?.hostPermissionOrigins?.length
      ? currentRun.hostPermissionOrigins
      : researchHostOrigins(currentRun?.sources.map(({ result }) => result.url) ?? []);
    request = requestResearchHostPermission(chrome.permissions, origins);
  } catch {
    statusSummaryEl.textContent = "Could not request page access";
    countsEl.textContent = "Open Scry in Manage extensions and allow Site access";
    button.disabled = false;
    return;
  }
  void request.then((granted) => {
    if (granted) return rerunResearch();
    statusSummaryEl.textContent = "Page access was not granted";
    countsEl.textContent = "Open Scry in Manage extensions and allow Site access";
  }).catch(() => {
    statusSummaryEl.textContent = "Could not request page access";
    countsEl.textContent = "Open Scry in Manage extensions and allow Site access";
  }).finally(() => { button.disabled = false; });
}

function renderPermissionHelp(target: HTMLElement): void {
  const help = make("div", "empty permission-help");
  help.append(make("p", undefined, "Scry needs access to the result sites to find relevant passages. Choose Allow page access, then approve Chrome’s prompt."));
  const retry = make("button", "permission-retry", "Allow page access");
  retry.type = "button";
  retry.addEventListener("click", () => requestPageAccessAndRetry(retry));
  help.append(retry);
  help.append(make("p", "permission-fallback", "If Chrome does not show a prompt, open Manage extensions → Scry → Site access and allow access to these result sites."));
  target.replaceChildren(help);
}

function rerunResearch(): Promise<void> {
  return chrome.runtime.sendMessage<{ ok: boolean; error?: string }>({ type: "RERUN_RESEARCH" })
    .then((response) => { if (response && !response.ok) statusSummaryEl.textContent = response.error ?? "Could not rerun research."; })
    .catch(() => { statusSummaryEl.textContent = "Could not rerun research."; });
}

const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tab")];
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => {
    activeView = tab.dataset.view === "passages" ? "passages" : "grouped";
    if (currentRun) render(currentRun);
  });
  tab.addEventListener("keydown", (event) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      tabs[nextIndex].focus();
      tabs[nextIndex].click();
    }
  });
});
rerunButton.addEventListener("click", () => {
  if (currentRun?.hostPermissionNeeded) {
    void requestPageAccessAndRetry(rerunButton);
    return;
  }
  void rerunResearch();
});
cancelButton.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "CANCEL_RESEARCH" }));
addModelSubmitEl.addEventListener("click", () => {
  const scorerIds = [...addModelOptionsEl.querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value);
  if (!scorerIds.length) return;
  addModelSubmitEl.disabled = true;
  void chrome.runtime.sendMessage<{ ok: boolean; error?: string }>({ type: "ADD_SCORERS", scorerIds }).then((response) => {
    if (!response?.ok) scoringStatusEl.textContent = response?.error ?? "Could not add scorer.";
    else addModelEl.open = false;
  }).catch(() => { scoringStatusEl.textContent = "Could not add scorer."; }).finally(() => { addModelSubmitEl.disabled = false; });
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "RUN_UPDATED") render(message.run as ResearchRunView);
});
void chrome.runtime.sendMessage<{ models?: Array<{ id: string; label: string; available: boolean }>; consensusAvailable?: boolean }>({ type: "GET_SCORING_CHOICES" }).then((response) => {
  scorerChoices = response?.models ?? [];
  consensusAvailable = Boolean(response?.consensusAvailable);
}).catch(() => undefined).finally(() => {
  void chrome.runtime.sendMessage<{ run: ResearchRunView | null }>({ type: "GET_RUN" }).then(({ run }) => render(run)).catch(() => render(null));
});
