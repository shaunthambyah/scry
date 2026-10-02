import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractMainContent, makeSourceText } from "../src/extraction/extractMainContent.js";
import { segmentPassages } from "../src/extraction/segmentPassages.js";

const html = readFileSync("fixtures/pages/nature.html", "utf8");

test("main content extraction drops boilerplate and keeps article headings and text", () => {
  const window = new JSDOM();
  const original = html;
  const extracted = extractMainContent(html, "https://nature.example/reasoning", new window.window.DOMParser() as unknown as DOMParser);
  const sourceText = makeSourceText(extracted.blocks);

  assert.equal(html, original, "input HTML string is not mutated");
  assert.equal(extracted.title, "Inference scaling and reasoning");
  assert.equal(extracted.canonicalUrl, "https://nature.example/reasoning");
  assert.equal(extracted.faviconUrl, "https://nature.example/icons/research.svg");
  assert.match(sourceText, /Increasing inference time improved accuracy/);
  assert.match(sourceText, /These results do not establish/);
  assert.doesNotMatch(sourceText, /Accept all cookies|Related stories|Copyright and privacy/);
  assert.ok(extracted.blocks.some((block) => block.headingPath.includes("Scaling results")));
  assert.ok(extracted.blocks.some((block) => block.kind === "quote"));
  assert.ok(extracted.blocks.some((block) => block.kind === "list"));
  window.window.close();
});

test("extraction falls back to the page-origin favicon instead of trusting a cross-origin icon URL", () => {
  const window = new JSDOM();
  const extracted = extractMainContent(
    '<!doctype html><html><head><title>Example article</title><link rel="icon" href="https://tracker.example/icon.png"></head><body><main><article><h1>Example article</h1><p>This sufficiently long article paragraph contains enough useful content for the structural extractor to keep it as page evidence.</p></article></main></body></html>',
    "https://source.example/story",
    new window.window.DOMParser() as unknown as DOMParser
  );
  assert.equal(extracted.faviconUrl, "https://source.example/favicon.ico");
  window.window.close();
});

test("passage segmentation merges short neighbors, splits long text, and keeps deterministic source ranges", () => {
  const blocks = [
    { text: "Brief setup.", headingPath: ["Method"], kind: "paragraph" as const },
    { text: "A second short sentence.", headingPath: ["Method"], kind: "paragraph" as const },
    { text: "A distinct longer paragraph discussing inference compute and fixed weights. ".repeat(22), headingPath: ["Results"], kind: "paragraph" as const },
    { text: "A final useful list item with enough context to stand alone.", headingPath: ["Results"], kind: "list" as const }
  ];
  const sourceText = makeSourceText(blocks);
  const first = segmentPassages(blocks, "fixture", "https://source.example/page", "hash", { hardMaxChars: 240 }, sourceText);
  const second = segmentPassages(blocks, "fixture", "https://source.example/page", "hash", { hardMaxChars: 240 }, sourceText);

  assert.deepEqual(first.map((passage) => passage.id), second.map((passage) => passage.id));
  assert.deepEqual(first.map((passage) => passage.text), second.map((passage) => passage.text));
  assert.equal(first[0].text, "Brief setup.\n\nA second short sentence.");
  assert.ok(first.length >= 3, "the long paragraph is split into useful pieces");
  assert.ok(first.every((passage) => sourceText.slice(passage.charStart, passage.charEnd) === passage.text));
  assert.ok(first.every((passage) => passage.sourcePositionMethod === "offset" && typeof passage.sourcePositionNormalized === "number" && passage.sourcePositionNormalized >= 0 && passage.sourcePositionNormalized <= 1));
  assert.deepEqual(first.at(-1)?.headingPath, ["Results"]);
});

test("source map positions fall back deterministically to passage sequence when offsets are unavailable", () => {
  const blocks = [
    { text: "First separate source passage with enough useful words for segmentation.", headingPath: ["First"], kind: "paragraph" as const },
    { text: "Second separate source passage with enough useful words for segmentation.", headingPath: ["Second"], kind: "paragraph" as const },
    { text: "Third separate source passage with enough useful words for segmentation.", headingPath: ["Third"], kind: "paragraph" as const }
  ];
  const passages = segmentPassages(blocks, "fallback", "https://source.example", "hash", {}, "");
  assert.deepEqual(passages.map(({ sourcePositionNormalized, sourcePositionMethod }) => [sourcePositionNormalized, sourcePositionMethod]), [[0, "sequence"], [0.5, "sequence"], [1, "sequence"]]);
});
