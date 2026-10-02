import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { GoogleSearchResultProvider } from "../dist/modules/content/googleSerpParser.js";
import { extractMainContent, makeSourceText } from "../dist/modules/extraction/extractMainContent.js";
import { createResearchRun, processResearchRun } from "../dist/modules/pipeline/researchPipeline.js";
import { MockPassageScorer } from "../dist/modules/ranking/jevClient.js";

const window = new JSDOM(await readFile("fixtures/google-serp.html", "utf8"), { url: "https://www.google.com/search?q=does+increased+inference+compute+improve+reasoning+at+fixed+model+weights" }).window;
const provider = new GoogleSearchResultProvider(window.document, window.location.href);
const query = provider.getQuery();
const results = provider.getResults();
const fixtureByHost = new Map([
  ["nature.example", "nature.html"],
  ["arxiv.example", "arxiv.html"],
  ["review.example", "boilerplate-heavy.html"]
]);
const run = createResearchRun("fixture-run", query, results);
await processResearchRun(run, {
  async load(result, setStage) {
    setStage("fetching");
    setStage("extracting");
    const fixtureName = fixtureByHost.get(result.domain);
    assert.ok(fixtureName, `No local page fixture for ${result.domain}`);
    const html = await readFile(`fixtures/pages/${fixtureName}`, "utf8");
    const parsed = extractMainContent(html, result.url, new window.DOMParser());
    const sourceText = makeSourceText(parsed.blocks);
    return {
      sourceId: result.id,
      result,
      url: parsed.canonicalUrl ?? result.url,
      title: parsed.title,
      domain: result.domain,
      documentHash: createHash("sha256").update(sourceText).digest("hex"),
      sourceText,
      blocks: parsed.blocks,
      status: "complete"
    };
  }
}, new MockPassageScorer(), () => {}, () => true);

for (const item of run.evidence) {
  const source = run.sources.find((entry) => entry.result.id === item.passage.sourceId)?.document;
  assert.ok(source?.sourceText.slice(item.passage.charStart, item.passage.charEnd) === item.passage.text, `Invalid provenance: ${item.passage.id}`);
}
console.log(`Fixture run complete: ${run.evidence.length} verbatim passages from ${run.sources.filter(({ status }) => status === "complete").length} sources.`);
console.log("Research-ranked sources:");
for (const score of run.sourceScores) {
  const source = run.sources.find((entry) => entry.result.id === score.sourceId);
  if (!source) throw new Error(`Missing source ${score.sourceId}`);
  console.log(`  #${score.researchRank} (Google #${score.googleRank}) — ${source.document?.title ?? source.result.title}`);
}
console.log("Top evidence:");
for (const item of run.evidence.slice(0, 3)) console.log(`  ${item.relevance.toFixed(2)} — ${item.passage.text}`);
window.close();
