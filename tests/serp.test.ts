import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { GoogleSearchResultProvider } from "../src/content/googleSerpParser.js";

test("Google SERP parser reads the query, skips ads, and deduplicates canonical URLs", () => {
  const html = readFileSync("fixtures/google-serp.html", "utf8");
  const window = new JSDOM(html, { url: "https://www.google.com/search?q=unused" }).window;
  const provider = new GoogleSearchResultProvider(window.document, window.location.href);

  assert.equal(provider.getQuery().text, "does increased inference compute improve reasoning at fixed model weights");
  assert.deepEqual(provider.getResults().map((result) => result.url), [
    "https://nature.example/reasoning",
    "https://arxiv.example/paper/123",
    "https://review.example/limits"
  ]);
  assert.deepEqual(provider.getResults().map((result) => result.googleRank), [1, 2, 3]);
  window.close();
});
