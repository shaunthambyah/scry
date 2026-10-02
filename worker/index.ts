import { type ClefModel, type ClefPassageInput, createClefQuestions } from "../src/scoring/clefProtocol.js";

interface AiBinding {
  run(modelId: string, input: { model: ClefModel; state: Record<string, unknown>; questions: Record<string, { type: "noul"; instructions: string }> }): Promise<unknown>;
}
interface RateLimitBinding { limit(options: { key: string }): Promise<{ success: boolean }>; }
interface Env { AI: AiBinding; RATE_LIMITER: RateLimitBinding; ALLOWED_ORIGIN: string; }

const MODEL_IDS: Record<ClefModel, string> = {
  "clef-flash": "@cf/cloudflare/clef-flash",
  clef: "@cf/cloudflare/clef"
};
const MAX_BODY_BYTES = 48_000;
const MAX_QUERY_LENGTH = 1_000;
const MAX_PASSAGES = 32;
const MAX_PASSAGE_LENGTH = 6_000;
const MAX_CONTEXT_LENGTH = 1_000;
const ALLOWED_HEADERS = "Content-Type";

function json(body: unknown, status: number, origin?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(JSON.stringify(body), { status, headers });
}
function fail(message: string, status: number, origin?: string): Response { return json({ error: message }, status, origin); }
function cleanText(value: unknown, max: number, field: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) throw new Error(`Invalid ${field}.`);
  return value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestOrigin = request.headers.get("Origin") ?? "";
    const allowedOrigin = env.ALLOWED_ORIGIN;
    if (!allowedOrigin || requestOrigin !== allowedOrigin) return fail("Origin is not allowed.", 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": ALLOWED_HEADERS, "Access-Control-Max-Age": "600", Vary: "Origin"
    } });
    if (new URL(request.url).pathname !== "/score") return fail("Not found.", 404, allowedOrigin);
    if (request.method !== "POST") return fail("Method not allowed.", 405, allowedOrigin)
    const contentLength = Number(request.headers.get("Content-Length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) return fail("Request body is too large.", 413, allowedOrigin);
    const ip = request.headers.get("CF-Connecting-IP") ?? "local-development";
    const rate = await env.RATE_LIMITER.limit({ key: ip });
    if (!rate.success) return fail("Rate limit exceeded.", 429, allowedOrigin);

    let input: unknown;
    try {
      if (!request.body) return fail("Expected a JSON request.", 400, allowedOrigin);
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel();
          return fail("Request body is too large.", 413, allowedOrigin);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return fail("Expected a JSON request.", 400, allowedOrigin); }
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid request.");
      const body = input as Record<string, unknown>;
      if (body.model !== "clef" && body.model !== "clef-flash") throw new Error("Model must be clef or clef-flash.");
      const model = body.model as ClefModel;
      const query = cleanText(body.query, MAX_QUERY_LENGTH, "query", true)!;
      if (!Array.isArray(body.passages) || body.passages.length < 1 || body.passages.length > MAX_PASSAGES) throw new Error(`Passages must contain 1–${MAX_PASSAGES} items.`);
      const passages: ClefPassageInput[] = body.passages.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid passage ${index + 1}.`);
        const value = raw as Record<string, unknown>;
        const id = cleanText(value.id, 120, "passage id", true)!;
        if (!/^[\w.:-]+$/.test(id)) throw new Error(`Invalid passage id ${id}.`);
        const heading = cleanText(value.heading, MAX_CONTEXT_LENGTH, "heading") ?? "";
        const text = cleanText(value.text, MAX_PASSAGE_LENGTH, "passage text", true)!;
        const previous = cleanText(value.previous, MAX_CONTEXT_LENGTH, "previous context");
        const next = cleanText(value.next, MAX_CONTEXT_LENGTH, "next context");
        return { id, heading, text, ...(previous === undefined ? {} : { previous }), ...(next === undefined ? {} : { next }) };
      });
      if (new Set(passages.map(({ id }) => id)).size !== passages.length) throw new Error("Passage IDs must be unique.");
      const questions = createClefQuestions(passages.map((passage) => ({ ...passage })));
      const state = { query, passages };
      let rawResult: unknown;
      try { rawResult = await env.AI.run(MODEL_IDS[model], { model, state, questions }); }
      catch { return fail("Workers AI scoring failed.", 502, allowedOrigin); }
      if (!rawResult || typeof rawResult !== "object") throw new Error("Workers AI returned a malformed result.");
      const answers = (rawResult as { answers?: unknown }).answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("Workers AI returned no answers.");
      const keyed = answers as Record<string, unknown>;
      if (Object.keys(keyed).length !== passages.length) throw new Error("Workers AI returned unexpected answer IDs.");
      const normalized: Record<string, { relevance: number }> = {};
      for (let index = 0; index < passages.length; index += 1) {
        const questionId = `relevance_${index + 1}`;
        const answer = keyed[questionId];
        const probability = answer && typeof answer === "object" ? (answer as { noul?: unknown }).noul : undefined;
        if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Workers AI omitted or malformed ${questionId}.`);
        normalized[passages[index].id] = { relevance: probability };
      }
      return json({ model, answers: normalized }, 200, allowedOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request.";
      const status = message.startsWith("Workers AI") ? 502 : 400;
      return fail(message, status, allowedOrigin);
    }
  }
};
