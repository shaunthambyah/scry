import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import type { Passage, ResearchRun, ResearchRunView, ScoredPassage, SearchResult, SourceDocument, SourceProgress } from "../src/models/types.js";
import { deriveSourceScores } from "../src/ranking/pageScore.js";
import { selectEvidenceForDisplay } from "../src/ranking/evidencePolicy.js";
import { evidenceCoverageSegments } from "../src/sidepanel/coverageMap.js";
import { researchHostOrigins } from "../src/background/hostPermissions.js";

function fixtureRun(status: ResearchRun["status"] = "complete", passageCount = 22): ResearchRun {
  const sources: SourceProgress[] = [];
  const sourceTexts = new Map<string, string[]>();
  for (let index = 0; index < 7; index += 1) {
    const result: SearchResult = {
      id: `source-${index + 1}`,
      url: `https://source-${index + 1}.example/article`,
      title: `Research article ${index + 1}`,
      domain: `source-${index + 1}.example`,
      googleRank: index + 1
    };
    const document: SourceDocument = {
      sourceId: result.id,
      result,
      url: result.url,
      title: result.title,
      domain: result.domain,
      faviconUrl: `https://${result.domain}/favicon.ico`,
      documentHash: `hash-${result.id}`,
      sourceText: "",
      blocks: [],
      status: "complete"
    };
    sources.push({ result, status: "complete", rawPassageCount: 0, document });
    sourceTexts.set(result.id, []);
  }

  const evidence: ScoredPassage[] = [];
  const headings = ["Housing Costs", "Childcare", "Taxes"];
  for (let index = 0; index < passageCount; index += 1) {
    const source = sources[Math.floor(index / 2) % sources.length];
    const text = `Verbatim evidence passage ${index + 1} describes a distinct research finding from the original source.`;
    const sourceTextParts = sourceTexts.get(source.result.id)!;
    sourceTextParts.push(text);
    const passage: Passage = {
      id: `${source.result.id}:p${index + 1}`,
      sourceId: source.result.id,
      url: source.result.url,
      headingPath: [headings[index % headings.length]],
      text,
      sourceIndex: sourceTextParts.length - 1,
      charStart: 0,
      charEnd: text.length,
      documentHash: `hash-${source.result.id}`
    };
    evidence.push({ passage, relevance: Math.max(0.35, 0.95 - index * 0.02), provenanceVerified: true, relation: "supports", evidenceStrength: 0.8 });
  }
  const irrelevantSource = sources[0];
  evidence.push({
    passage: { id: "irrelevant:p1", sourceId: irrelevantSource.result.id, url: irrelevantSource.result.url, headingPath: [], text: "Explicitly irrelevant passage.", sourceIndex: 99, charStart: 0, charEnd: 29, documentHash: `hash-${irrelevantSource.result.id}` },
    relevance: 0.99,
    provenanceVerified: true,
    relation: "irrelevant"
  });

  for (const source of sources) {
    const texts = sourceTexts.get(source.result.id)!;
    const body = texts.join("\n\n");
    source.document!.sourceText = body;
    source.rawPassageCount = texts.length;
    let cursor = 0;
    for (const item of evidence.filter(({ passage }) => passage.sourceId === source.result.id && passage.id !== "irrelevant:p1")) {
      const at = body.indexOf(item.passage.text, cursor);
      item.passage.charStart = at;
      item.passage.charEnd = at + item.passage.text.length;
      item.passage.sourcePositionNormalized = at / Math.max(1, body.length);
      item.passage.sourcePositionMethod = "offset";
      cursor = item.passage.charEnd + 2;
    }
  }
  const query = { text: "family housing childcare taxes in San Francisco", normalized: "family housing childcare taxes in san francisco" };
  selectEvidenceForDisplay(evidence, sources).forEach((item, index) => { item.globalRank = index + 1; });
  const sourceScores = deriveSourceScores(sources, evidence);
  return {
    runId: "panel-test-run",
    query,
    status,
    sources,
    evidence,
    sourceScores,
  };
}

async function mountPanel(run: ResearchRun, permissionGrant = true): Promise<{ dom: JSDOM; window: Window; messages: Array<{ type?: string }>; permissionRequests: Array<{ origins: string[] }>; createdTabs: Array<{ url: string; active: boolean }> }> {
  const html = readFileSync("dist/extension/sidepanel/index.html", "utf8");
  const script = readFileSync("dist/extension/sidepanel/panel.js", "utf8");
  const dom = new JSDOM(html, { url: "chrome-extension://test/sidepanel/index.html", runScripts: "outside-only" });
  const messages: Array<{ type?: string }> = [];
  const permissionRequests: Array<{ origins: string[] }> = [];
  const createdTabs: Array<{ url: string; active: boolean }> = [];
  const { candidateSet, modelJudgments: _modelJudgments, sourceScores, ...baseRun } = run;
  const runView: ResearchRunView = {
    ...baseRun,
    sourceScores,
    canAddModels: Boolean(candidateSet?.frozen && candidateSet.candidates.length)
  };
  const chromeMock = {
    permissions: {
      request: async (permission: { origins: string[] }) => {
        permissionRequests.push(permission);
        return permissionGrant;
      }
    },
    tabs: {
      create: async (tab: { url: string; active: boolean }) => { createdTabs.push(tab); return { id: createdTabs.length }; }
    },
    runtime: {
      onMessage: { addListener: () => undefined },
      sendMessage: async (message: { type?: string }) => {
        messages.push(message);
        if (message.type === "GET_RUN") return { run: runView };
        if (message.type === "GET_SCORING_CHOICES") return { models: [{ id: "clef-flash", label: "Clef Flash", available: true }, { id: "clef", label: "Clef", available: true }, { id: "jev", label: "Jev", available: true }], consensusAvailable: true, defaultMode: "clef-flash" };
        if (message.type === "OPEN_EVIDENCE_AT_SOURCE") return { handled: true, ok: true };
        return { ok: true };
      }
    }
  };
  Object.defineProperty(dom.window, "chrome", { value: chromeMock, configurable: true });
  dom.window.eval(script);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, window: dom.window as unknown as Window, messages, permissionRequests, createdTabs };
}

test("Consensus presentation uses ranks without percentage claims and offers only unscored models", async () => {
  const run = fixtureRun("complete", 2);
  const selected = run.evidence[0];
  selected.relevance = 1;
  selected.fusedRank = 1;
  selected.globalRank = 1;
  selected.scorerCount = 2;
  run.evidence = [selected];
  run.scoring = { mode: "consensus", selectedScorerIds: ["clef-flash", "clef"], successfulScorerIds: ["clef-flash", "clef"], failedScorerIds: [], fusion: { type: "rrf", k: 60, weights: { "clef-flash": 1, clef: 1 } } };
  run.candidateSet = { frozen: true, candidates: [{ passage: selected.passage, prefilterScore: 1 }] };
  run.sourceScores = deriveSourceScores(run.sources, run.evidence);
  const { dom, window } = await mountPanel(run);
  assert.match(window.document.querySelector("#scoring-status")?.textContent ?? "", /Consensus · 2 models/);
  assert.equal(window.document.querySelector("#add-model")?.hasAttribute("hidden"), false);
  assert.equal(window.document.querySelector<HTMLInputElement>(".add-model-option input")?.value, "jev");
  assert.doesNotMatch(window.document.querySelector("#grouped-view")?.textContent ?? "", /%/);
  assert.match(window.document.querySelector("#grouped-view")?.textContent ?? "", /#1 consensus/);
  dom.window.close();
});

test("Grouped is primary and source dossiers preserve global ranks with passage text and source provenance", async () => {
  const run = fixtureRun("complete", 6);
  const { dom, window, messages } = await mountPanel(run);
  assert.equal(window.document.querySelector("#grouped-tab")?.getAttribute("aria-selected"), "true");
  assert.equal(window.document.querySelector("#passages-view")?.hasAttribute("hidden"), true);
  const dossiers = window.document.querySelectorAll<HTMLElement>("#grouped-view .source-dossier");
  assert.equal(dossiers.length, 3);
  assert.deepEqual([...dossiers].map((dossier) => dossier.querySelector(".dossier-rank")?.textContent), ["01", "02", "03"]);
  assert.deepEqual([...dossiers[0].querySelectorAll(".passage-rank")].map((rank) => rank.textContent), ["#1 overall", "#2 overall"]);
  assert.deepEqual([...dossiers[1].querySelectorAll(".passage-rank")].map((rank) => rank.textContent), ["#3 overall", "#4 overall"]);
  assert.match(dossiers[0].textContent!, /95% best match/);
  assert.match(dossiers[0].textContent!, /Google #1/);
  assert.equal(dossiers[0].querySelectorAll(".coverage-segment").length, 2);
  assert.ok(dossiers[0].querySelector<HTMLElement>(".coverage-map")?.getAttribute("aria-label")?.includes("start to finish"));
  const dossierSourceLink = dossiers[0].querySelector<HTMLAnchorElement>(".source-link")!;
  const dossierTitleLink = dossiers[0].querySelector<HTMLAnchorElement>(".dossier-title-link")!;
  assert.ok(dossierSourceLink.href.startsWith("https://source-1.example/"));
  assert.doesNotMatch(dossierSourceLink.href, /:~:text=/, "favicon/domain opens the source normally");
  assert.doesNotMatch(dossierTitleLink.href, /:~:text=/, "source title opens the source normally");
  for (const passage of window.document.querySelectorAll<HTMLElement>("#grouped-view .passage-text")) {
    const domain = passage.closest(".source-dossier")?.querySelector(".source-domain")?.textContent;
    const source = run.sources.find(({ result }) => result.domain === domain);
    assert.ok(source?.document?.sourceText.includes(passage.textContent ?? ""), "grouped evidence remains verbatim");
  }
  assert.doesNotMatch(window.document.querySelector("#grouped-view")!.textContent!, /sourceRankScore|confidence|probability|accuracy/);
  dom.window.close();
});

test("Grouped dossiers keep the cross-source overall ranks instead of renumbering locally", async () => {
  const run = fixtureRun("complete", 6);
  const firstSource = run.sources[0];
  const thirdPassageForFirstSource = run.evidence[5].passage;
  const sourceText = firstSource.document!.sourceText;
  const passageStart = sourceText.length + 2;
  firstSource.document!.sourceText = `${sourceText}\n\n${thirdPassageForFirstSource.text}`;
  firstSource.rawPassageCount = 3;
  Object.assign(thirdPassageForFirstSource, {
    id: "source-1:p3",
    sourceId: firstSource.result.id,
    url: firstSource.result.url,
    sourceIndex: 2,
    charStart: passageStart,
    charEnd: passageStart + thirdPassageForFirstSource.text.length,
    documentHash: firstSource.document!.documentHash
  });
  const scores = [0.92, 0.84, 0.91, 0.80, 0.89, 0.76];
  run.evidence.slice(0, 6).forEach((item, index) => { item.relevance = scores[index]; });
  const ranked = selectEvidenceForDisplay(run.evidence, run.sources);
  ranked.forEach((item, index) => { item.globalRank = index + 1; });
  run.sourceScores = deriveSourceScores(run.sources, run.evidence);
  const { dom, window } = await mountPanel(run);
  const dossiers = [...window.document.querySelectorAll<HTMLElement>("#grouped-view .source-dossier")];
  assert.deepEqual(dossiers[0].querySelectorAll(".passage-rank").length, 3);
  assert.deepEqual([...dossiers[0].querySelectorAll(".passage-rank")].map((node) => node.textContent), ["#1 overall", "#4 overall", "#6 overall"]);
  assert.equal(dossiers[0].querySelector<HTMLButtonElement>(".expand-source")?.textContent, "+ 1 more passage");
  assert.deepEqual([...dossiers[1].querySelectorAll(".passage-rank")].map((node) => node.textContent), ["#2 overall", "#5 overall"]);
  assert.deepEqual([...dossiers[2].querySelectorAll(".passage-rank")].map((node) => node.textContent), ["#3 overall"]);
  dom.window.close();
});

test("Passages view is global, preserves source repetition and global ranks, and expands past twenty", async () => {
  const run = fixtureRun("complete", 22);
  const { dom, window, messages, createdTabs } = await mountPanel(run);
  window.document.querySelector<HTMLButtonElement>("#passages-tab")!.click();
  const rows = window.document.querySelectorAll<HTMLElement>("#passages-view .global-passage");
  assert.equal(rows.length, 20);
  assert.deepEqual([...rows].slice(0, 6).map((row) => row.querySelector(".passage-rank")?.textContent), ["#1 overall", "#2 overall", "#3 overall", "#4 overall", "#5 overall", "#6 overall"]);
  assert.deepEqual([...rows].slice(0, 4).map((row) => row.querySelector(".source-domain")?.textContent), ["source-1.example", "source-1.example", "source-2.example", "source-2.example"]);
  assert.equal(window.document.querySelector("#debug-output"), null);
  const globalSourceLink = rows[0].querySelector<HTMLAnchorElement>(".source-link")!;
  const globalTitleLink = rows[0].querySelector<HTMLAnchorElement>(".global-title")!;
  const passageLink = rows[0].querySelector<HTMLAnchorElement>(".passage-text")!;
  assert.doesNotMatch(globalSourceLink.href, /:~:text=/, "domain/favicon opens the source normally");
  assert.doesNotMatch(globalTitleLink.href, /:~:text=/, "title opens the source normally");
  assert.match(passageLink.href, /#:~:text=/, "evidence keeps its native exact-text target");
  const passageClick = window.document.createEvent("MouseEvent");
  passageClick.initEvent("click", true, true);
  passageLink.dispatchEvent(passageClick);
  assert.equal(passageClick.defaultPrevented, true, "evidence navigation is routed through source-tab reuse");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(messages.some((message) => message.type === "OPEN_EVIDENCE_AT_SOURCE"));
  assert.equal(createdTabs.length, 0, "the side panel does not open a second tab when the worker handled navigation");
  window.document.querySelector<HTMLButtonElement>(".show-more")!.click();
  assert.equal(window.document.querySelectorAll("#passages-view .global-passage").length, 22);
  for (const passage of window.document.querySelectorAll<HTMLElement>("#passages-view .passage-text")) {
    const domain = passage.closest(".global-passage")?.querySelector(".source-domain")?.textContent;
    const source = run.sources.find(({ result }) => result.domain === domain);
    assert.ok(source?.document?.sourceText.includes(passage.textContent ?? ""), "global passages remain verbatim");
  }
  dom.window.close();
});

test("all ranked passages remain visible without a topic facet control", async () => {
  const run = fixtureRun("complete", 6);
  const originalRanks = run.evidence.map(({ globalRank }) => globalRank);
  const originalScores = run.evidence.map(({ relevance }) => relevance);
  const { dom, window } = await mountPanel(run);
  assert.equal(window.document.querySelector("#facet-strip"), null);
  assert.equal(window.document.querySelectorAll(".facet, [data-facet-id]").length, 0);
  const dossiers = [...window.document.querySelectorAll<HTMLElement>("#grouped-view .source-dossier")];
  assert.equal(dossiers.length, 3);
  assert.deepEqual(dossiers.flatMap((dossier) => [...dossier.querySelectorAll(".passage-rank")].map((node) => node.textContent)), ["#1 overall", "#2 overall", "#3 overall", "#4 overall", "#5 overall", "#6 overall"]);
  assert.deepEqual(run.evidence.map(({ globalRank }) => globalRank), originalRanks);
  assert.deepEqual(run.evidence.map(({ relevance }) => relevance), originalScores);
  dom.window.close();
});

test("missing page access requests from the button click, then reruns after a grant", async () => {
  const run = fixtureRun("failed", 0);
  run.hostPermissionNeeded = true;
  run.sources.forEach((source) => { source.status = "failed"; source.document = undefined; source.error = "Destination host permission was not granted."; });
  run.sourceScores = [];
  const { dom, window, messages, permissionRequests } = await mountPanel(run);
  assert.equal(window.document.querySelector("#status-summary")?.textContent, "Page access needed");
  assert.match(window.document.querySelector(".permission-help")?.textContent ?? "", /needs access to the result sites/i);
  const allowButton = window.document.querySelector<HTMLButtonElement>("#grouped-view .permission-retry")!;
  assert.equal(allowButton.textContent, "Allow page access");
  allowButton.click();
  assert.equal(permissionRequests.length, 1, "Chrome's permission API is invoked synchronously in the click handler");
  assert.deepEqual([...permissionRequests[0].origins], researchHostOrigins(run.sources.map(({ result }) => result.url)));
  assert.equal(messages.some((message) => message.type === "RERUN_RESEARCH"), false, "the run waits until the permission promise resolves");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(messages.some((message) => message.type === "RERUN_RESEARCH"));
  window.document.querySelector<HTMLButtonElement>("#passages-tab")!.click();
  assert.ok(window.document.querySelector("#passages-view .permission-help"));
  dom.window.close();
});

test("declining page access keeps the allow action available and does not rerun", async () => {
  const run = fixtureRun("failed", 0);
  run.hostPermissionNeeded = true;
  run.sources.forEach((source) => { source.status = "failed"; source.document = undefined; });
  run.sourceScores = [];
  const { dom, window, messages, permissionRequests } = await mountPanel(run, false);
  window.document.querySelector<HTMLButtonElement>("#grouped-view .permission-retry")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(permissionRequests.length, 1);
  assert.equal(window.document.querySelector("#status-summary")?.textContent, "Page access was not granted");
  assert.equal(window.document.querySelector("#grouped-view .permission-retry")?.hasAttribute("disabled"), false);
  assert.equal(messages.some((message) => message.type === "RERUN_RESEARCH"), false);
  dom.window.close();
});

test("the header retry control requests missing page access before rerunning", async () => {
  const run = fixtureRun("failed", 0);
  run.hostPermissionNeeded = true;
  run.sources.forEach((source) => { source.status = "failed"; source.document = undefined; });
  run.sourceScores = [];
  const { dom, window, messages, permissionRequests } = await mountPanel(run);
  const retry = window.document.querySelector<HTMLButtonElement>("#rerun")!;
  assert.equal(retry.getAttribute("aria-label"), "Allow page access and retry");
  retry.click();
  assert.equal(permissionRequests.length, 1);
  assert.equal(messages.some((message) => message.type === "RERUN_RESEARCH"), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(messages.some((message) => message.type === "RERUN_RESEARCH"));
  dom.window.close();
});

test("coverage sections reveal, select, and highlight their corresponding passage", async () => {
  const run = fixtureRun("complete", 22);
  const { dom, window } = await mountPanel(run);
  const firstDossier = window.document.querySelector<HTMLElement>("#grouped-view .source-dossier")!;
  const hiddenPassage = firstDossier.querySelector<HTMLElement>("#global-passage-15")!;
  assert.equal(hiddenPassage.hidden, true);
  const section = [...firstDossier.querySelectorAll<HTMLButtonElement>(".coverage-segment")].find((button) => button.title.startsWith("#15 overall"));
  assert.ok(section);
  section.click();
  const revealed = window.document.querySelector<HTMLElement>("#global-passage-15")!;
  assert.equal(revealed.hidden, false);
  assert.equal(revealed.classList.contains("highlight"), true);
  assert.equal(revealed.classList.contains("selected"), true);
  assert.equal(section.classList.contains("selected"), true);
  assert.equal(window.document.querySelector<HTMLButtonElement>("#grouped-view .expand-source")?.getAttribute("aria-expanded"), "true");
  assert.equal(window.document.querySelector(".map-marker, .evidence-map, .evidence-map-track"), null);
  dom.window.close();
});

test("selecting dossier evidence marks its coverage section and preserves source navigation", async () => {
  const { dom, window, messages } = await mountPanel(fixtureRun("complete", 6));
  const dossier = window.document.querySelector<HTMLElement>("#grouped-view .source-dossier")!;
  const passage = dossier.querySelector<HTMLElement>(".dossier-passage")!;
  const passageLink = passage.querySelector<HTMLAnchorElement>(".passage-text")!;
  const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  passageLink.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(passage.classList.contains("selected"), true);
  const section = [...dossier.querySelectorAll<HTMLButtonElement>(".coverage-segment")]
    .find((button) => (JSON.parse(button.dataset.passageIds ?? "[]") as string[]).includes(passage.dataset.passageId ?? ""));
  assert.ok(section?.classList.contains("selected"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(messages.some((message) => message.type === "OPEN_EVIDENCE_AT_SOURCE"), "the existing source click-through route remains active");
  dom.window.close();
});

test("coverage segments use document spans in source order and text-length fallback", () => {
  const item = (id: string, sourceIndex: number, rank: number, charStart: number, charEnd: number, textLength = 40, method?: "offset" | "sequence"): ScoredPassage => ({
    passage: { id, sourceId: "map", url: "https://map.example", headingPath: [], text: "x".repeat(textLength), sourceIndex, charStart, charEnd, sourcePositionMethod: method, documentHash: "hash" },
    relevance: 0.8,
    globalRank: rank,
    provenanceVerified: true
  });
  const segments = evidenceCoverageSegments([
    item("late", 4, 4, 720, 820),
    item("early", 0, 1, 100, 200),
    item("fallback", 2, 3, -1, -1, 40, "sequence")
  ], 1000, 5);
  assert.deepEqual(segments.map(({ primaryPassageId }) => primaryPassageId), ["early", "fallback", "late"]);
  assert.deepEqual(segments.map(({ positionMethod }) => positionMethod), ["offset", "sequence", "offset"]);
  assert.ok(Math.abs(segments[0].start - 0.1) < 1e-10);
  assert.ok(Math.abs(segments[0].width - 0.1) < 1e-10);
  assert.ok(Math.abs(segments[1].start - 0.4) < 1e-10);
  assert.ok(Math.abs(segments[2].start - 0.72) < 1e-10);
  assert.ok(Math.abs(segments[2].width - 0.1) < 1e-10);

  const fallback = evidenceCoverageSegments([
    item("short", 2, 1, -1, -1, 50, "sequence"),
    item("long", 6, 2, -1, -1, 100, "sequence")
  ], 0, 10);
  assert.deepEqual(fallback.map(({ primaryPassageId }) => primaryPassageId), ["short", "long"]);
  assert.ok(Math.abs(fallback[0].start - 0.2) < 1e-10);
  assert.ok(Math.abs(fallback[1].start - 0.6) < 1e-10);
  assert.ok(fallback[1].width > fallback[0].width, "fallback span widths scale with passage text length");
});

test("adjacent and heavily overlapping spans merge deterministically while retaining passage IDs", () => {
  const item = (id: string, start: number, end: number, rank: number, relevance: number): ScoredPassage => ({
    passage: { id, sourceId: "map", url: "https://map.example", headingPath: [], text: id, sourceIndex: rank, charStart: start, charEnd: end, documentHash: "hash" },
    relevance,
    globalRank: rank
  });
  const spans = evidenceCoverageSegments([
    item("overlap-a", 100, 200, 3, 0.7),
    item("overlap-b", 150, 190, 2, 0.9),
    item("adjacent", 201, 300, 4, 0.6)
  ], 1000, 5);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].passageIds, ["overlap-a", "overlap-b", "adjacent"]);
  assert.equal(spans[0].primaryPassageId, "overlap-b");
  assert.ok(Math.abs(spans[0].start - 0.1) < 1e-10);
  assert.ok(Math.abs(spans[0].end - 0.3) < 1e-10);
});

test("irrelevant passages do not enter either research view", async () => {
  const { dom, window } = await mountPanel(fixtureRun("complete", 6));
  assert.ok(!window.document.querySelector("#grouped-view")!.textContent?.includes("Explicitly irrelevant"));
  assert.equal(window.document.querySelector("#debug-output"), null);
  window.document.querySelector<HTMLButtonElement>("#passages-tab")!.click();
  assert.ok(!window.document.querySelector("#passages-view")!.textContent?.includes("Explicitly irrelevant"));
  dom.window.close();
});

test("completed provenance collapses, limits favicons, falls back safely, and opens source details", async () => {
  const { dom, window } = await mountPanel(fixtureRun());
  const details = window.document.querySelector<HTMLDetailsElement>("#provenance")!;
  assert.equal(details.open, false);
  assert.equal(details.querySelectorAll("#favicon-stack .favicon-stack-item").length, 5);
  assert.equal(details.querySelector(".favicon-overflow")?.textContent, "+2");
  details.querySelector("summary")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(details.open, true);
  assert.equal(details.querySelectorAll(".status-row").length, 7);
  const image = details.querySelector<HTMLImageElement>("#favicon-stack img")!;
  image.dispatchEvent(new dom.window.Event("error"));
  assert.equal(image.parentElement?.classList.contains("fallback"), true);
  assert.match(readFileSync("dist/extension/sidepanel/panel.css", "utf8"), /favicon-stack-item \+ \.favicon-stack-item[^}]*margin-left:\s*-6px/);
  dom.window.close();
});

test("running provenance stays open, reports live progress, and source status remains accessible", async () => {
  const run = fixtureRun("running", 4);
  for (const source of run.sources.slice(3)) source.status = "queued";
  const { dom, window } = await mountPanel(run);
  const details = window.document.querySelector<HTMLDetailsElement>("#provenance")!;
  assert.equal(details.open, true);
  assert.equal(window.document.querySelector("#status-summary")?.textContent, "Researching 3 of 7 sources");
  assert.equal(window.document.querySelector("#progress-track")?.getAttribute("aria-valuenow"), "3");
  assert.equal(window.document.querySelectorAll(".status-row").length, 7);
  dom.window.close();
});

test("compact header, calm palette, accessible view switch, source links, and rerun action remain usable", async () => {
  const run = fixtureRun();
  const { dom, window, messages } = await mountPanel(run);
  assert.equal(window.document.querySelector("#query")?.textContent, "family housing childcare taxes in San Francisco");
  assert.doesNotMatch(window.document.body.textContent!, /SEARCH QUERY|SOURCE RESEARCH|Passage evidence|Completed/);
  const css = readFileSync("dist/extension/sidepanel/panel.css", "utf8");
  const theme = readFileSync("dist/extension/shared/theme.css", "utf8");
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /background:\s*var\(--scry-white\)/);
  assert.match(theme, /--scry-white:\s*#FFFFFF/);
  assert.match(theme, /--scry-gray:\s*#A2A2A2/);
  assert.match(theme, /--scry-mist:\s*#D4DDE2/);
  assert.match(theme, /--scry-blue:\s*#5C7E8F/);
  const shell = window.document.querySelector(".sticky-shell")!;
  assert.ok(shell.children[3]?.classList.contains("tabs"), "tabs follow the provenance summary without an extra controls row");
  const keyEvent = new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  window.document.querySelector<HTMLButtonElement>("#grouped-tab")!.dispatchEvent(keyEvent);
  assert.equal(window.document.querySelector("#passages-tab")?.getAttribute("aria-selected"), "true");
  assert.equal(window.document.querySelector<HTMLAnchorElement>(".source-link")!.getAttribute("aria-label"), "Open source-1.example");
  assert.ok(window.document.querySelector<HTMLAnchorElement>(".passage-text")!.href.includes(":~:text="));
  assert.equal(window.document.querySelector<HTMLButtonElement>("#rerun")!.getAttribute("aria-label"), "Rerun current results");
  assert.equal(window.document.querySelector<HTMLAnchorElement>(".settings-link")!.getAttribute("aria-label"), "Settings");
  window.document.querySelector<HTMLButtonElement>("#rerun")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(messages.some((message) => message.type === "RERUN_RESEARCH"));
  dom.window.close();
});
