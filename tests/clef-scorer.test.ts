import assert from "node:assert/strict";
import test from "node:test";
import type { PassageCandidate } from "../src/models/types.js";
import { CloudflareClefHttpTransport, CloudflareClefScorer, type ClefTransport } from "../src/scoring/cloudflareClefScorer.js";
import { createClefBatches, type ClefModel, type ClefPassageInput } from "../src/scoring/clefProtocol.js";
import worker from "../worker/index.js";
import { evidenceCoverageSegments } from "../src/sidepanel/coverageMap.js";

function candidate(id: string, text: string): PassageCandidate {
  return { prefilterScore: 0.6, passage: {
    id, sourceId: "s1", url: "https://source.example/page", headingPath: ["Results", "Details"], text,
    previousText: "preceding text", nextText: "following text", sourceIndex: 0, charStart: 0, charEnd: text.length, documentHash: "hash"
  } };
}

class FakeTransport implements ClefTransport {
  calls: Array<{ model: ClefModel; query: string; passages: ClefPassageInput[] }> = [];
  constructor(private readonly scorer: (batch: ClefPassageInput[]) => Record<string, number> = (batch) => Object.fromEntries(batch.map((p) => [p.id, 0.75]))) {}
  async scoreBatch(request: { model: ClefModel; query: string; passages: ClefPassageInput[] }): Promise<Record<string, number>> {
    this.calls.push(structuredClone(request));
    return this.scorer(request.passages);
  }
}

test("Clef scorer sends exact structured passages and normalizes YES probabilities without altering source text", async () => {
  const p1 = candidate("p1", "A literal passage."); const p2 = candidate("p2", "Another literal passage.");
  const transport = new FakeTransport((batch) => Object.fromEntries(batch.map((item, index) => [item.id, [0.91, 0.72][index]])));
  const scorer = new CloudflareClefScorer("clef-flash", transport);
  const originalText = [p1.passage.text, p2.passage.text];
  const results = await scorer.score("query Q", [p1, p2]);
  assert.equal(transport.calls[0].query, "query Q");
  assert.equal(transport.calls[0].model, "clef-flash");
  assert.deepEqual(transport.calls[0].passages.map(({ id }) => id), ["p1", "p2"]);
  assert.equal(transport.calls[0].passages[0].text, "A literal passage.");
  assert.deepEqual(results.map(({ relevance }) => relevance), [0.91, 0.72]);
  assert.equal(results[0].passage, p1.passage);
  assert.deepEqual([p1.passage.text, p2.passage.text], originalText);
});

test("Clef scorer batches deterministically and rejects missing, unknown, and malformed scores", async () => {
  const candidates = Array.from({ length: 70 }, (_, i) => candidate(`p${i}`, `Passage ${i}`));
  const transport = new FakeTransport();
  const results = await new CloudflareClefScorer("clef", transport, 32).score("q", candidates);
  assert.deepEqual(transport.calls.map(({ passages }) => passages.length), [32, 32, 6]);
  assert.ok(transport.calls.every(({ passages }) => passages.length <= 64));
  assert.deepEqual(results.map(({ passage }) => passage.id), candidates.map(({ passage }) => passage.id));
  const byteBatches = createClefBatches("q", [{ id: "a", heading: "", text: "x".repeat(3000) }, { id: "b", heading: "", text: "y".repeat(3000) }], 32, 4000);
  assert.deepEqual(byteBatches.map((batch) => batch.length), [1, 1]);
  assert.throws(() => createClefBatches("q", [{ id: "large", heading: "", text: "x".repeat(5000) }], 32, 4000), /exceeds.*size limit/);
  await assert.rejects(() => new CloudflareClefScorer("clef", new FakeTransport(() => ({ p1: 0.5 }))).score("q", [candidate("p1", "a"), candidate("p2", "b")]), /omitted relevance/);
  await assert.rejects(() => new CloudflareClefScorer("clef", new FakeTransport(() => ({ unexpected: 0.5 }))).score("q", [candidate("p1", "a")]), /unknown passage id/);
  await assert.rejects(() => new CloudflareClefScorer("clef", new FakeTransport(() => ({ p1: 1.5 }))).score("q", [candidate("p1", "a")]), /invalid relevance/);
});

test("HTTP transport uses the exact Workers AI model selector and validates response IDs and probabilities", async () => {
  let sent: any;
  const fetcher: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: "clef-flash", answers: { p1: { relevance: 0.5 } } }), { status: 200 });
  };
  const transport = new CloudflareClefHttpTransport("https://scoring.example/score", fetcher);
  assert.deepEqual(await transport.scoreBatch({ model: "clef-flash", query: "q", passages: [{ id: "p1", heading: "h", text: "source" }] }), { p1: 0.5 });
  assert.equal(sent.model, "clef-flash");
  assert.equal(sent.passages[0].text, "source");
  await assert.rejects(() => new CloudflareClefHttpTransport("https://scoring.example/score", async () => new Response(JSON.stringify({ model: "clef", answers: { p1: { relevance: 2 } } }), { status: 200 })).scoreBatch({ model: "clef", query: "q", passages: [{ id: "p1", heading: "", text: "x" }] }), /invalid relevance/);
});

test("Worker constrains model selection, constructs typed noul questions, and returns passage-keyed probabilities", async () => {
  let modelId = ""; let input: any;
  const env = {
    ALLOWED_ORIGIN: "chrome-extension://unit-test",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    AI: { run: async (model: string, payload: unknown) => {
      modelId = model; input = payload;
      return { answers: { relevance_1: { noul: 0.9 }, relevance_2: { noul: 0.2 } } };
    } }
  };
  const response = await worker.fetch(new Request("https://worker.example/score", {
    method: "POST", headers: { Origin: env.ALLOWED_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "clef-flash", query: "query Q", passages: [{ id: "p1", text: "Exact 1" }, { id: "p2", text: "Exact 2" }] })
  }), env);
  assert.equal(response.status, 200);
  assert.equal(modelId, "@cf/cloudflare/clef-flash");
  assert.equal(input.model, "clef-flash");
  assert.deepEqual(input.state, { query: "query Q", passages: [{ id: "p1", heading: "", text: "Exact 1" }, { id: "p2", heading: "", text: "Exact 2" }] });
  assert.ok(Object.values(input.questions).every((q: any) => q.type === "noul" && q.instructions.includes("substantive")));
  assert.deepEqual((await response.json() as any).answers, { p1: { relevance: 0.9 }, p2: { relevance: 0.2 } });
});

test("Worker denies unapproved origins and invalid/unbounded requests before Workers AI", async () => {
  let calls = 0;
  const env = { ALLOWED_ORIGIN: "chrome-extension://allowed", RATE_LIMITER: { limit: async () => ({ success: true }) }, AI: { run: async () => { calls++; return {}; } } };
  const create = (origin: string, body: unknown) => new Request("https://worker.example/score", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(create("https://attacker.example", { model: "clef", query: "q", passages: [{ id: "p", text: "x" }] }), env)).status, 403);
  assert.equal((await worker.fetch(create(env.ALLOWED_ORIGIN, { model: "arbitrary", query: "q", passages: [{ id: "p", text: "x" }] }), env)).status, 400);
  assert.equal((await worker.fetch(create(env.ALLOWED_ORIGIN, { model: "clef", query: "q", passages: Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, text: "x" })) }), env)).status, 400);
  assert.equal(calls, 0);
});

test("equivalent normalized relevance maps to identical coverage positions", () => {
  const normalized = [candidate("p1", "Evidence about revenue."), candidate("p2", "A second useful passage.")].map(({ passage }, index) => ({
    passage: { ...passage, sourceIndex: index, charStart: index * 100, charEnd: index * 100 + 30 }, relevance: [0.9, 0.6][index], globalRank: index + 1, provenanceVerified: true
  }));
  const localScores = normalized.map((item) => ({ ...item }));
  const clefScores = normalized.map((item) => ({ ...item }));
  assert.deepEqual(localScores.map(({ passage, relevance, globalRank }) => [passage.id, relevance, globalRank]), clefScores.map(({ passage, relevance, globalRank }) => [passage.id, relevance, globalRank]));
  assert.deepEqual(evidenceCoverageSegments(localScores, 300, 3), evidenceCoverageSegments(clefScores, 300, 3));
});

test("Worker rate limits and contains Workers AI failures", async () => {
  const base = { ALLOWED_ORIGIN: "chrome-extension://allowed", RATE_LIMITER: { limit: async () => ({ success: false }) }, AI: { run: async () => ({}) } };
  const request = () => new Request("https://worker.example/score", { method: "POST", headers: { Origin: base.ALLOWED_ORIGIN }, body: JSON.stringify({ model: "clef", query: "q", passages: [{ id: "p", text: "text" }] }) });
  assert.equal((await worker.fetch(request(), base)).status, 429);
  const aiFailureEnv = { ...base, RATE_LIMITER: { limit: async () => ({ success: true }) }, AI: { run: async () => { throw new Error("secret upstream detail"); } } };
  const response = await worker.fetch(request(), aiFailureEnv);
  assert.equal(response.status, 502);
  assert.equal((await response.json() as any).error, "Workers AI scoring failed.");
  const unknownAnswerEnv = { ...base, RATE_LIMITER: { limit: async () => ({ success: true }) }, AI: { run: async () => ({ answers: { relevance_1: { noul: 0.8 }, unexpected: { noul: 0.2 } } }) } };
  const unknownResponse = await worker.fetch(request(), unknownAnswerEnv);
  assert.equal(unknownResponse.status, 502);
});

test("Clef HTTP transport reports rate limits and aborts its active request", async () => {
  const rateLimited = new CloudflareClefHttpTransport("https://worker.example/score", async () => new Response("", { status: 429 }));
  await assert.rejects(() => rateLimited.scoreBatch({ model: "clef", query: "q", passages: [{ id: "p", heading: "", text: "x" }] }), /429.*rate limited/);
  const controller = new AbortController();
  const pending = new CloudflareClefHttpTransport("https://worker.example/score", (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })).scoreBatch({ model: "clef", query: "q", passages: [{ id: "p", heading: "", text: "x" }] }, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, /cancelled/);
});


test("Clef batch failure returns no partial score list or fabricated values", async () => {
  let calls = 0;
  const transport: ClefTransport = { async scoreBatch(request) {
    calls++;
    if (calls === 2) throw new Error("network failure");
    return Object.fromEntries(request.passages.map((passage) => [passage.id, 0.8]));
  } };
  const scorer = new CloudflareClefScorer("clef", transport, 1);
  await assert.rejects(() => scorer.score("q", [candidate("p1", "one"), candidate("p2", "two")]), /network failure/);
  assert.equal(calls, 2);
});
