import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, ScoredPassage, SearchResult, SourceDocument } from "../src/models/types.js";
import { makeSourceText } from "../src/extraction/extractMainContent.js";
import { createResearchRun, processResearchRun } from "../src/pipeline/researchPipeline.js";
import { MockPassageScorer } from "../src/ranking/jevClient.js";
import { deriveSourceScores } from "../src/ranking/pageScore.js";
import { SOURCE_RANK_CONFIG } from "../src/ranking/pageScore.js";
import { compareEvidence, relevancePercent, selectEvidenceForDisplay } from "../src/ranking/evidencePolicy.js";

const query = { text: "inference compute reasoning fixed weights", normalized: "inference compute reasoning fixed weights" };

function result(id: string, rank: number): SearchResult {
  return { id, url: `https://${id}.example/article`, title: `${id} article`, domain: `${id}.example`, googleRank: rank };
}

function documentFor(searchResult: SearchResult, blocks: ContentBlock[]): SourceDocument {
  return {
    sourceId: searchResult.id,
    result: searchResult,
    url: searchResult.url,
    title: searchResult.title,
    domain: searchResult.domain,
    documentHash: `hash-${searchResult.id}`,
    sourceText: makeSourceText(blocks),
    blocks,
    status: "complete"
  };
}

test("pipeline globally ranks verbatim passages, derives source ranks, and tolerates a failed source", async () => {
  const good = result("strong", 3);
  const weaker = result("weak", 1);
  const blocks: ContentBlock[] = [
    { text: "Inference compute reasoning fixed weights: increasing inference compute improved reasoning while model weights stayed fixed across the evaluated tasks. The result supports additional test-time computation.", headingPath: ["Results"], kind: "paragraph" },
    { text: "The benchmark included a small sample and several limitations for interpreting the results.", headingPath: ["Limitations"], kind: "paragraph" }
  ];
  const weakBlocks: ContentBlock[] = [
    { text: "This article mentions inference compute and reasoning with fixed weights, but offers little experimental detail.", headingPath: ["Overview"], kind: "paragraph" }
  ];
  const run = createResearchRun("run-1", query, [good, weaker, result("blocked", 2)]);
  const updates: number[] = [];
  const completed = await processResearchRun(run, {
    async load(searchResult, setStage) {
      setStage("fetching");
      if (searchResult.id === "blocked") throw new Error("HTTP 403");
      setStage("extracting");
      return documentFor(searchResult, searchResult.id === "strong" ? blocks : weakBlocks);
    }
  }, new MockPassageScorer(), (next) => updates.push(next.evidence.length), () => true, { concurrency: 2, perPageCandidateLimit: 12 });

  assert.equal(completed.status, "complete");
  assert.equal(completed.sources.filter(({ status }) => status === "failed").length, 1);
  assert.equal(completed.sources.filter(({ status }) => status === "complete").length, 2);
  assert.ok(completed.evidence.length > 0);
  assert.equal(completed.evidence[0].passage.sourceId, "strong", "global evidence ordering follows passage relevance");
  assert.ok(completed.evidence.every(({ passage }) => {
    const source = completed.sources.find((item) => item.result.id === passage.sourceId)?.document;
    return source?.sourceText.slice(passage.charStart, passage.charEnd) === passage.text;
  }));
  const ranked = completed.evidence.filter(({ globalRank }) => globalRank !== undefined).sort((a, b) => a.globalRank! - b.globalRank!);
  assert.deepEqual(ranked.map(({ globalRank }) => globalRank), ranked.map((_item, index) => index + 1));
  assert.equal(completed.sourceScores[0].sourceId, "strong");
  assert.ok(updates.some((count) => count > 0), "progress update exposes evidence before the run completes");
});

test("source rank uses the configured diminishing return weights and ignores page length", () => {
  const one = result("one", 1);
  const two = result("two", 2);
  const sources = [one, two].map((item) => ({ result: item, status: "complete" as const, rawPassageCount: 1000 }));
  const makePassage = (source: SearchResult, index: number, relevance: number, text = `${source.id} passage ${index}`) => ({
    passage: { id: `${source.id}:${index}`, sourceId: source.id, url: source.url, headingPath: [], text, sourceIndex: index, charStart: index * 1000, charEnd: index * 1000 + text.length, documentHash: "x" },
    relevance,
    provenanceVerified: true
  });
  const evidence = [
    ...[0.90, 0.88, 0.84, ...Array(80).fill(0.01)].map((relevance, index) => makePassage(one, index, relevance)),
    makePassage(two, 0, 0.93)
  ];
  const scores = deriveSourceScores(sources, evidence);
  const pageA = scores.find((score) => score.sourceId === "one")!;
  const pageB = scores.find((score) => score.sourceId === "two")!;
  assert.deepEqual(SOURCE_RANK_CONFIG.passageWeights, [1, 0.20, 0.10, 0.05, 0.025]);
  assert.equal(pageA.topPassage.relevance, 0.90);
  assert.equal(pageA.researchRank, 1, "three excellent passages can outrank one slightly stronger passage");
  assert.equal(pageB.researchRank, 2);

  const exceptional = result("exceptional", 3);
  const middling = result("middling", 4);
  const comparativeScores = deriveSourceScores([exceptional, middling].map((item) => ({ result: item, status: "complete" as const, rawPassageCount: 5 })), [
    makePassage(exceptional, 0, 0.96),
    ...[0.65, 0.65, 0.65, 0.65, 0.65].map((score, index) => makePassage(middling, index, score))
  ]);
  assert.ok(comparativeScores.find(({ sourceId }) => sourceId === exceptional.id)!.researchRank < comparativeScores.find(({ sourceId }) => sourceId === middling.id)!.researchRank, "one exceptional passage can outrank several mediocre passages");
});

test("global passage ranks preserve the requested cross-source ordering and source-local evidence", () => {
  const a = result("a", 1);
  const b = result("b", 2);
  const c = result("c", 3);
  const sources = [a, b, c].map((item) => ({ result: item, status: "complete" as const, rawPassageCount: 3 }));
  const makePassage = (source: SearchResult, id: string, index: number, relevance: number): ScoredPassage => ({
    passage: { id, sourceId: source.id, url: source.url, headingPath: [], text: `Exact source evidence ${id} is kept verbatim.`, sourceIndex: index, charStart: index * 100, charEnd: index * 100 + 40, documentHash: "hash" },
    relevance,
    provenanceVerified: true
  });
  const evidence = [
    makePassage(a, "a1", 0, 0.92), makePassage(a, "a2", 1, 0.84), makePassage(a, "a3", 2, 0.76),
    makePassage(b, "b1", 0, 0.91), makePassage(b, "b2", 1, 0.80),
    makePassage(c, "c1", 0, 0.89)
  ];
  const ranked = selectEvidenceForDisplay(evidence, sources);
  ranked.forEach((item, index) => { item.globalRank = index + 1; });
  assert.deepEqual(ranked.map(({ passage }) => passage.id), ["a1", "b1", "c1", "a2", "b2", "a3"]);
  const groupedRanks = new Map<string, number[]>();
  for (const item of ranked) {
    const group = groupedRanks.get(item.passage.sourceId) ?? [];
    group.push(item.globalRank!);
    groupedRanks.set(item.passage.sourceId, group);
  }
  assert.deepEqual(groupedRanks.get(a.id), [1, 4, 6]);
  assert.deepEqual(groupedRanks.get(b.id), [2, 5]);
  assert.deepEqual(groupedRanks.get(c.id), [3]);
});

test("exact and overlapping passages cannot count twice in a source rank", () => {
  const page = result("duplicates", 1);
  const passage = (id: string, score: number, start: number, end: number, text: string) => ({
    passage: { id, sourceId: page.id, url: page.url, headingPath: [], text, sourceIndex: start, charStart: start, charEnd: end, documentHash: "hash" },
    relevance: score,
    provenanceVerified: true
  });
  const source = { result: page, status: "complete" as const, rawPassageCount: 4 };
  const repeatedText = "A long source passage describes an experimental result and its measured reasoning improvements. ".repeat(3);
  const scores = deriveSourceScores([source], [
    passage("best", 0.95, 0, repeatedText.length, repeatedText),
    passage("overlap", 0.90, repeatedText.length - 20, repeatedText.length + 80, "A different sentence that overlaps the first passage range."),
    passage("repeat", 0.87, repeatedText.length + 100, repeatedText.length * 2, repeatedText),
    passage("near-repeat", 0.82, repeatedText.length * 2 + 100, repeatedText.length * 3, `${repeatedText} Added.`)
  ]);
  assert.equal(scores[0].topPassage.passage.id, "best");
  assert.equal(scores[0].researchRank, 1);
  assert.equal(selectEvidenceForDisplay([
    passage("best", 0.95, 0, repeatedText.length, repeatedText),
    passage("overlap", 0.90, repeatedText.length - 20, repeatedText.length + 80, "A different sentence that overlaps the first passage range.")
  ], [source]).length, 1);
  const punctuationVariant = repeatedText.toLowerCase().replace(/\./g, ",").replace(/ /g, "  ");
  const nearScores = deriveSourceScores([source], [
    passage("punctuation-original", 0.93, 0, repeatedText.length, repeatedText),
    passage("punctuation-variant", 0.89, 1000, 1000 + punctuationVariant.length, punctuationVariant)
  ]);
  assert.equal(nearScores[0].topPassage.passage.id, "punctuation-original", "case, punctuation, and whitespace-only variants collapse before ranking");
});

test("evidence ranking uses raw relevance before tie-breakers", () => {
  const item = (id: string, sourceId: string, relevance: number, evidenceStrength?: number) => ({
    passage: { id, sourceId, url: `https://${sourceId}.example`, headingPath: [], text: id, sourceIndex: 0, charStart: 0, charEnd: id.length, documentHash: "x" },
    relevance,
    evidenceStrength,
    provenanceVerified: true
  });
  const ranks = new Map([["first", 1], ["later", 9]]);
  assert.equal(relevancePercent(0.84), 84);
  assert.ok(compareEvidence(item("higher", "later", 0.84), item("lower", "first", 0.79), ranks) < 0);
  assert.ok(compareEvidence(item("stronger", "later", 0.841, 0.9), item("weaker", "first", 0.844, 0.1), ranks) > 0, "higher raw relevance wins even when the displayed percentages match");
  assert.ok(compareEvidence(item("stronger", "later", 0.844, 0.9), item("weaker", "first", 0.844, 0.1), ranks) < 0, "evidence strength breaks an exact relevance tie");
  assert.ok(compareEvidence(item("google-first", "first", 0.844), item("google-later", "later", 0.844), ranks) < 0, "Google rank is the final source-level tie-breaker");
});

test("normal evidence filters explicit irrelevance", () => {
  const source = result("filter", 1);
  const common = { sourceId: source.id, url: source.url, headingPath: [], sourceIndex: 0, charStart: 0, charEnd: 10, documentHash: "x" };
  const useful = { passage: { ...common, id: "useful", text: "Useful text" }, relevance: 0.8, provenanceVerified: true };
  const irrelevant = { passage: { ...common, id: "irrelevant", text: "Not useful" }, relevance: 0.99, relation: "irrelevant" as const, provenanceVerified: true };
  const sources = [{ result: source, status: "complete" as const, rawPassageCount: 2 }];
  assert.deepEqual(selectEvidenceForDisplay([useful, irrelevant], sources).map(({ passage }) => passage.id), ["useful"]);
  assert.equal([useful, irrelevant].length, 2);
  assert.equal(irrelevant.relation, "irrelevant");
});

test("a cancelled old run emits no late evidence into its successor", async () => {
  const oldResult = result("old", 1);
  const oldRun = createResearchRun("old-run", query, [oldResult]);
  let release!: (value: SourceDocument) => void;
  let isCurrent = true;
  let updateAfterCancel = false;
  const delayedDocument = new Promise<SourceDocument>((resolve) => { release = resolve; });
  const pending = processResearchRun(oldRun, {
    async load() { return delayedDocument; }
  }, new MockPassageScorer(), () => { if (!isCurrent) updateAfterCancel = true; }, () => isCurrent);
  await Promise.resolve();
  isCurrent = false;
  release(documentFor(oldResult, [{ text: "Inference compute improves reasoning at fixed model weights with strong evidence.", headingPath: ["Results"], kind: "paragraph" }]));
  const cancelled = await pending;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.evidence.length, 0);
  assert.equal(updateAfterCancel, false);
});

test("a scorer cannot substitute generated text for a source passage", async () => {
  const searchResult = result("source", 1);
  const exactText = "Inference compute improves reasoning while model weights remain fixed in the measured experiment.";
  const run = createResearchRun("provenance-run", query, [searchResult]);
  await processResearchRun(run, {
    async load() {
      return documentFor(searchResult, [{ text: exactText, headingPath: ["Results"], kind: "paragraph" }]);
    }
  }, {
    id: "adversarial-test",
    label: "Adversarial test scorer",
    name: "Adversarial test scorer",
    async score(_query, candidates) {
      return candidates.map(({ passage }) => ({ passage: { ...passage, text: "A generated answer that was not on the page." }, relevance: 0.99 }));
    }
  }, () => {}, () => true);

  assert.equal(run.evidence[0].passage.text, exactText);
  assert.equal(run.evidence[0].provenanceVerified, true);
});

test("duplicate canonical destinations contribute evidence once", async () => {
  const first = result("first", 1);
  const duplicate = result("second", 2);
  const run = createResearchRun("canonical-run", query, [first, duplicate]);
  const duplicateBlocks: ContentBlock[] = [{ text: "Inference compute improves reasoning with fixed model weights in this result.", headingPath: ["Results"], kind: "paragraph" }];
  await processResearchRun(run, {
    async load(searchResult) {
      const document = documentFor(searchResult, duplicateBlocks);
      document.url = "https://canonical.example/same-article";
      return document;
    }
  }, new MockPassageScorer(), () => {}, () => true, { concurrency: 1 });

  assert.equal(run.sources.filter(({ status }) => status === "complete").length, 2);
  assert.ok(run.evidence.every((item) => item.passage.sourceId === "first"));
});
