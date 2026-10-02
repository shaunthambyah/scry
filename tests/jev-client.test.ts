import assert from "node:assert/strict";
import test from "node:test";
import type { PassageCandidate } from "../src/models/types.js";
import { JevPassageScorer, TypeSafeJevTransport } from "../src/ranking/jevClient.js";

function candidate(id: string, text: string): PassageCandidate {
  return {
    prefilterScore: 0.8,
    passage: {
      id,
      sourceId: "source-1",
      url: "https://source.example/article",
      headingPath: ["Results", "Scaling"],
      text,
      previousText: "Previous context.",
      nextText: "Next context.",
      sourceIndex: 0,
      charStart: 0,
      charEnd: text.length,
      documentHash: "hash"
    }
  };
}

test("TypeSafe Jev transport batches exact passages and maps structured scores back to originals", async () => {
  const first = candidate("source-1:p1", "Increasing inference compute improved reasoning.");
  const second = candidate("source-1:p2", "The study reports a small sample size.");
  let sentBody: Record<string, any> = {};
  let authorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        passage_1: { type: "score", score: 4 },
        passage_2: { type: "score", score: 2 }
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const scorer = new JevPassageScorer(new TypeSafeJevTransport("restricted-dev-key", fakeFetch));

  const scores = await scorer.score("does inference compute improve reasoning?", [first, second]);

  assert.equal(authorization, "Bearer restricted-dev-key");
  assert.equal(sentBody?.model, "jev-latest");
  assert.equal(sentBody?.state.query, "does inference compute improve reasoning?");
  assert.equal(sentBody?.state.passages[0].text, first.passage.text);
  assert.equal(sentBody?.questions.passage_1.type, "score");
  assert.ok(sentBody?.questions.passage_1.instructions.compare.includes("`passages[0].text`"));
  assert.deepEqual(scores.map((item) => item.relevance), [1, 0.5]);
  assert.equal(scores[0].passage, first.passage, "the transport result maps back to the original source passage");
  assert.equal(scores[1].passage, second.passage);
});

test("TypeSafe Jev transport retries a rate-limited request", async () => {
  let attempts = 0;
  const fakeFetch: typeof fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ answers: { passage_1: { type: "score", score: 3 } } }), { status: 200 });
  };
  const transport = new TypeSafeJevTransport("restricted-dev-key", fakeFetch);
  const result = await transport.scorePassages({
    query: "test query",
    passages: [{ id: "p1", headingPath: [], text: "test evidence" }]
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result, [{ passageId: "p1", relevance: 0.75 }]);
});

test("TypeSafe Jev transport invokes the default fetch with its global scope bound", async () => {
  const originalFetch = globalThis.fetch;
  let correctThis = false;
  const contextualFetch: typeof fetch = function (this: typeof globalThis) {
    correctThis = this === globalThis;
    return Promise.resolve(new Response(JSON.stringify({ answers: { passage_1: { type: "score", score: 2 } } }), { status: 200 }));
  };
  globalThis.fetch = contextualFetch;
  try {
    const transport = new TypeSafeJevTransport("restricted-dev-key");
    const result = await transport.scorePassages({
      query: "test query",
      passages: [{ id: "p1", headingPath: [], text: "test evidence" }]
    });
    assert.equal(correctThis, true);
    assert.deepEqual(result, [{ passageId: "p1", relevance: 0.5 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
