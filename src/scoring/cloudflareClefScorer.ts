import type { PassageCandidate, PassageScorer, ScoredPassage } from "../models/types.js";
import { CLEF_BATCH_SIZE, createClefBatches, type ClefModel, type ClefPassageInput, validateClefProbability } from "./clefProtocol.js";

export interface ClefTransport {
  scoreBatch(request: { model: ClefModel; query: string; passages: ClefPassageInput[] }, signal?: AbortSignal): Promise<Record<string, number>>;
}

export class CloudflareClefScorer implements PassageScorer {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  constructor(private readonly model: ClefModel, private readonly transport: ClefTransport, private readonly batchSize = CLEF_BATCH_SIZE, private readonly maxBatchBytes = 42_000) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error("Clef batch size must be between 1 and 64.");
    this.id = `cloudflare-${model}`;
    this.label = model === "clef-flash" ? "Clef Flash" : "Clef";
    this.name = this.label;
  }

  async score(query: string, candidates: PassageCandidate[], signal?: AbortSignal): Promise<ScoredPassage[]> {
    const output: ScoredPassage[] = [];
    const inputs = candidates.map(({ passage }): ClefPassageInput => ({
      id: passage.id, heading: passage.headingPath.join(" › "), text: passage.text, previous: passage.previousText, next: passage.nextText
    }));
    const batches = createClefBatches(query, inputs, this.batchSize, this.maxBatchBytes);
    for (const inputBatch of batches) {
      if (signal?.aborted) throw new Error("Clef scoring cancelled.");
      const batchIds = new Set(inputBatch.map(({ id }) => id));
      const batch = candidates.filter(({ passage }) => batchIds.has(passage.id));
      const byId = new Map(batch.map(({ passage }) => [passage.id, passage]));
      const answers = await this.transport.scoreBatch({
        model: this.model,
        query,
        passages: inputBatch
      }, signal);
      for (const [passageId, raw] of Object.entries(answers)) {
        const passage = byId.get(passageId);
        if (!passage) throw new Error(`Clef returned an unknown passage id: ${passageId}.`);
        output.push({ passage, relevance: validateClefProbability(raw, passageId) });
      }
      for (const { passage } of batch) {
        if (!Object.hasOwn(answers, passage.id)) throw new Error(`Clef omitted relevance for passage ${passage.id}.`);
      }
    }
    return output;
  }
}

export class CloudflareClefHttpTransport implements ClefTransport {
  private readonly fetcher: typeof fetch;
  constructor(private readonly endpoint: string, fetcher?: typeof fetch, private readonly timeoutMs = 45_000) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw new Error("Scoring endpoint must use HTTPS (localhost is allowed for development).");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Scoring endpoint must not include credentials, query parameters, or a fragment.");
    if (parsed.pathname !== "/score") throw new Error("Scoring Worker endpoint must use /score.");
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async scoreBatch(request: { model: ClefModel; query: string; passages: ClefPassageInput[] }, signal?: AbortSignal): Promise<Record<string, number>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Scoring Worker returned HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}.`);
      const payload = await response.json() as { model?: unknown; answers?: unknown };
      if (payload.model !== request.model || !payload.answers || typeof payload.answers !== "object" || Array.isArray(payload.answers)) {
        throw new Error("Scoring Worker returned a malformed response.");
      }
      const answers: Record<string, number> = {};
      for (const [id, value] of Object.entries(payload.answers)) {
        const relevance = value && typeof value === "object" ? (value as { relevance?: unknown }).relevance : undefined;
        answers[id] = validateClefProbability(relevance, id);
      }
      return answers;
    } catch (error) {
      if (signal?.aborted) throw new Error("Clef scoring cancelled.");
      if (controller.signal.aborted) throw new Error(`Clef scoring timed out after ${this.timeoutMs / 1000}s.`);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}
