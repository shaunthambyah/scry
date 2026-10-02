import assert from "node:assert/strict";
import test from "node:test";
import type { PassageCandidate, ScoredPassage, SearchResult } from "../src/models/types.js";
import { applyRunRanking, createResearchRun, processResearchRun, scoreFrozenCandidates } from "../src/pipeline/researchPipeline.js";
import { makeSourceText } from "../src/extraction/extractMainContent.js";
import { ReciprocalRankFusion, RRF_CONFIG } from "../src/scoring/rankFusion.js";

const query = { text: "frozen evidence", normalized: "frozen evidence" };
const fusion = new ReciprocalRankFusion();

function candidates(ids: string[]): PassageCandidate[] {
  return ids.map((id, index) => ({ prefilterScore: 1, passage: {
    id, sourceId: index % 2 ? "source-b" : "source-a", url: `https://source-${index % 2 ? "b" : "a"}.example/`,
    headingPath: [], text: `Exact source passage ${id} with frozen evidence.`, sourceIndex: index,
    charStart: index * 50, charEnd: index * 50 + 43, documentHash: "frozen-hash"
  } }));
}

function ranking(list: Array<[string, number]>, all: PassageCandidate[]): ScoredPassage[] {
  const byId = new Map(all.map(({ passage }) => [passage.id, passage]));
  return list.map(([id, relevance]) => ({ passage: byId.get(id)!, relevance, provenanceVerified: true }));
}

test("RRF uses centralized k=60, equal weights, and ignores raw score magnitudes", () => {
  assert.equal(RRF_CONFIG.k, 60);
  assert.equal(RRF_CONFIG.defaultWeight, 1);
  const all = candidates(["a", "b", "c"]);
  const result = fusion.fuse(all, {
    one: ranking([["a", 0.99], ["b", 0.8], ["c", 0.2]], all),
    two: ranking([["a", 0.55], ["b", 0.54], ["c", 0.53]], all)
  });
  assert.deepEqual(result.passages.map(({ passage }) => passage.id), ["a", "b", "c"]);
  assert.equal(result.passages[0].fusedRank, 1);
  assert.equal(result.passages[1].fusedRank, 2);
  assert.deepEqual(result.passages.map(({ scorerCount }) => scorerCount), [2, 2, 2]);
});

test("agreement can outrank a lone top rank and the A/B RRF fixture ranks A first", () => {
  const all = candidates(["A", "B", ...Array.from({ length: 90 }, (_, i) => `f${i}`)]);
  const fillerIds = all.slice(2).map(({ passage }) => passage.id);
  const order = (positions: Array<[string, number]>) => {
    const values = [...fillerIds];
    const selected = new Map(positions.map(([id, rank]) => [rank - 1, id]));
    const reserved = new Set(positions.map(([id]) => id));
    const result: string[] = [];
    let nextFiller = 0;
    const size = Math.max(values.length + reserved.size, ...selected.keys()) + 1;
    for (let index = 0; index < size; index += 1) {
      if (selected.has(index)) result[index] = selected.get(index)!;
      else while (nextFiller < values.length && reserved.has(values[nextFiller])) nextFiller += 1;
      if (!selected.has(index) && nextFiller < values.length) result[index] = values[nextFiller++];
    }
    return result.filter(Boolean).map((id, index) => [id, 1 - index / 1000] as [string, number]);
  };
  const fixture = fusion.fuse(all, {
    "clef-flash": ranking(order([["B", 1], ["A", 2]]), all),
    clef: ranking(order([["A", 4], ["B", 80]]), all),
    jev: ranking(order([["A", 5], ["B", 90]]), all)
  });
  assert.ok(fixture.passages.findIndex(({ passage }) => passage.id === "A") < fixture.passages.findIndex(({ passage }) => passage.id === "B"));
  const agreement = fusion.fuse(all, {
    one: ranking(order([["B", 1], ["A", 2]]), all),
    two: ranking(order([["A", 2], ["B", 80]]), all),
    three: ranking(order([["A", 2], ["B", 90]]), all)
  });
  assert.ok(agreement.passages.findIndex(({ passage }) => passage.id === "A") < agreement.passages.findIndex(({ passage }) => passage.id === "B"));
});

test("upfront consensus and incremental addition yield identical passage and source ranks", () => {
  const all = candidates(["p1", "p2", "p3", "p4"]);
  const outputs = {
    "clef-flash": ranking([["p2", 0.9], ["p1", 0.8], ["p4", 0.3], ["p3", 0.2]], all),
    clef: ranking([["p1", 0.95], ["p3", 0.7], ["p2", 0.6], ["p4", 0.1]], all),
    jev: ranking([["p1", 0.88], ["p2", 0.83], ["p3", 0.4], ["p4", 0.2]], all)
  };
  const results: SearchResult[] = ["source-a", "source-b"].map((id, index) => ({ id, url: `https://${id}.example`, title: id, domain: `${id}.example`, googleRank: index + 1 }));
  const upfront = createResearchRun("upfront", query, results);
  const incremental = createResearchRun("incremental", query, results);
  for (const run of [upfront, incremental]) {
    run.candidateSet = { frozen: true, candidates: all };
    run.scoring = { mode: "consensus", selectedScorerIds: ["clef-flash", "clef", "jev"], successfulScorerIds: ["clef-flash", "clef", "jev"], failedScorerIds: [], fusion: { type: "rrf", k: 60, weights: { "clef-flash": 1, clef: 1, jev: 1 } } };
  }
  upfront.modelJudgments = outputs;
  incremental.modelJudgments = { "clef-flash": outputs["clef-flash"] };
  applyRunRanking(incremental);
  incremental.modelJudgments.clef = outputs.clef;
  applyRunRanking(incremental);
  incremental.modelJudgments.jev = outputs.jev;
  applyRunRanking(incremental);
  applyRunRanking(upfront);
  const shape = (run: ReturnType<typeof createResearchRun>) => ({
    passages: run.evidence.map(({ passage, scorerCount, fusedRank }) => [passage.id, fusedRank, scorerCount]),
    sources: run.sourceScores.map(({ sourceId, researchRank }) => [sourceId, researchRank])
  });
  assert.deepEqual(shape(incremental), shape(upfront));
});

test("the local development scorer never contributes a vote to normal Consensus", () => {
  const all = candidates(["p1", "p2", "p3"]);
  const run = createResearchRun("without-mock-vote", query, []);
  run.candidateSet = { frozen: true, candidates: all };
  run.scoring = { mode: "consensus", selectedScorerIds: ["mock", "clef", "jev"], successfulScorerIds: ["mock", "clef", "jev"], failedScorerIds: [], fusion: { type: "rrf", k: 60, weights: { mock: 1, clef: 1, jev: 1 } } };
  run.modelJudgments = {
    mock: ranking([["p3", 1], ["p2", 0.5], ["p1", 0]], all),
    clef: ranking([["p1", 1], ["p2", 0.5], ["p3", 0]], all),
    jev: ranking([["p1", 1], ["p3", 0.5], ["p2", 0]], all)
  };
  applyRunRanking(run);
  const expected = fusion.fuse(all, { clef: run.modelJudgments.clef, jev: run.modelJudgments.jev });
  assert.deepEqual(run.evidence.map(({ passage, fusedRank }) => [passage.id, fusedRank]), expected.passages.map(({ passage, fusedRank }) => [passage.id, fusedRank]));
});

test("adding a scorer consumes saved frozen candidates without invoking the source loader", async () => {
  const all = candidates(["saved-1", "saved-2"]);
  const run = createResearchRun("run", query, [
    { id: "source-a", url: "https://source-a.example", title: "a", domain: "source-a.example", googleRank: 1 },
    { id: "source-b", url: "https://source-b.example", title: "b", domain: "source-b.example", googleRank: 2 }
  ]);
  run.candidateSet = { frozen: true, candidates: all };
  let scorerCalls = 0;
  const result = await scoreFrozenCandidates(run, {
    id: "clef", name: "Clef", label: "Clef",
    async score(_query, batch) { scorerCalls += 1; return batch.map((item, index) => ({ passage: item.passage, relevance: 0.8 - index * 0.1 })); }
  }, new AbortController().signal, () => true);
  assert.equal(scorerCalls, 2, "one scoring batch for each frozen source group");
  assert.equal(result.error, undefined);
  assert.equal(run.modelJudgments?.clef.length, 2);
});

test("the full candidate set is frozen after retrieval and shared identically across concurrent scorers", async () => {
  const result: SearchResult = { id: "source", url: "https://source.example/", title: "Source", domain: "source.example", googleRank: 1 };
  const run = createResearchRun("frozen-run", query, [result]);
  const blocks = [
    { text: "Frozen evidence appears in this research passage, with sufficient detail to verify a stable verbatim extracted source span and preserve candidate provenance.", headingPath: ["Evidence"], kind: "paragraph" as const },
    { text: "Additional frozen evidence appears in a separate passage, preserving enough source text for deterministic segmentation, extraction, and scorer ranking in the test.", headingPath: ["Results"], kind: "paragraph" as const }
  ];
  const sourceText = makeSourceText(blocks);
  let loaderCalls = 0;
  const received: Record<string, string[]> = {};
  const makeScorer = (id: string, score: number) => ({
    id, name: id, label: id,
    async score(_query: string, batch: PassageCandidate[]) {
      assert.equal(loaderCalls, 1, "scoring begins after every source has completed extraction and prefiltering");
      received[id] = batch.map(({ passage }) => passage.id);
      return batch.map(({ passage }) => ({ passage, relevance: score }));
    }
  });
  const completed = await processResearchRun(run, {
    async load(searchResult) {
      loaderCalls += 1;
      return {
        sourceId: searchResult.id, result: searchResult, url: searchResult.url, title: searchResult.title, domain: searchResult.domain,
        documentHash: "frozen", documentLength: sourceText.length, sourceText, blocks, status: "complete" as const
      };
    }
  }, [makeScorer("one", 0.8), makeScorer("two", 0.4)], () => undefined, () => true, { perPageCandidateLimit: 16 });
  assert.equal(completed.status, "complete");
  assert.equal(loaderCalls, 1);
  assert.ok(completed.candidateSet);
  assert.deepEqual(received.one, received.two);
  assert.deepEqual(received.one, completed.candidateSet!.candidates.map(({ passage }) => passage.id));
});
