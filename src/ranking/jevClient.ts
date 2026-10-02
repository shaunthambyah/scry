import type { PassageCandidate, PassageScorer, ScoredPassage } from "../models/types.js";
import { queryTerms } from "./prefilter.js";

/** Local deterministic heuristic for development; it judges relevance and never emits passage text. */
export class MockPassageScorer implements PassageScorer {
  readonly id = "mock-lexical";
  readonly label = "Mock lexical scorer";
  readonly name = this.label;
  async score(query: string, candidates: PassageCandidate[], _signal?: AbortSignal): Promise<ScoredPassage[]> {
    const terms = queryTerms(query);
    const result = candidates.map(({ passage }) => {
      const haystack = `${passage.headingPath.join(" ")} ${passage.text}`.toLowerCase();
      const matched = terms.filter((term) => haystack.includes(term));
      const coverage = terms.length ? matched.length / terms.length : 0;
      const queryPhrase = terms.join(" ");
      const exactBoost = queryPhrase && haystack.includes(queryPhrase) ? 0.1 : 0;
      const density = Math.min(0.15, matched.length / Math.max(1, passage.text.length / 180));
      const relevance = Math.max(0, Math.min(1, coverage * 0.68 + density + exactBoost));
      return {
        passage,
        relevance: Number(relevance.toFixed(4)),
        evidenceStrength: Number(Math.min(1, (passage.text.length / 450) * 0.55 + density).toFixed(4)),
        relation: relevance >= 0.45 ? "context" as const : "irrelevant" as const
      };
    });
    return result;
  }
}

export interface JevTransport {
  scorePassages(request: {
    query: string;
    passages: Array<{ id: string; headingPath: string[]; text: string; context?: string }>;
  }, signal?: AbortSignal): Promise<Array<{ passageId: string; relevance: number; evidenceStrength?: number; relation?: ScoredPassage["relation"] }>>;
}

/** Adapter boundary for the real Jev runtime. Inject a JevTransport once its protocol is known. */
export class JevPassageScorer implements PassageScorer {
  readonly id = "jev";
  readonly label = "Jev passage scorer";
  readonly name = this.label;
  constructor(private readonly transport: JevTransport) {}

  async score(query: string, candidates: PassageCandidate[], signal?: AbortSignal): Promise<ScoredPassage[]> {
    const byId = new Map(candidates.map(({ passage }) => [passage.id, passage]));
    const judgments = await this.transport.scorePassages({
      query,
      passages: candidates.map(({ passage }) => ({
        id: passage.id,
        headingPath: passage.headingPath,
        text: passage.text,
        context: [passage.previousText, passage.nextText].filter(Boolean).join(" ") || undefined
      }))
    }, signal);
    return judgments.flatMap((judgment) => {
      const passage = byId.get(judgment.passageId);
      if (!passage || !Number.isFinite(judgment.relevance)) return [];
      return [{ passage, relevance: Math.max(0, Math.min(1, judgment.relevance)), evidenceStrength: judgment.evidenceStrength, relation: judgment.relation }];
    });
  }
}

interface TypeSafeQuestion {
  type: "score";
  instructions: Record<string, string | string[]>;
  criteria: string[];
}

interface TypeSafeResponse {
  answers?: Record<string, { type?: string; score?: number }>;
}

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 45_000;
const RETRY_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const RELEVANCE_LEVELS = [
  "Not relevant: the passage does not bear on the query.",
  "Weakly relevant: it mentions a related term but provides little useful information.",
  "Relevant context: it helps frame the question but does not directly address it.",
  "Directly relevant: it addresses an important part of the query with useful detail.",
  "Highly relevant: it provides specific, substantive evidence directly bearing on the query."
];

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(MAX_RETRY_AFTER_MS, delay)) : null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Jev scoring cancelled."));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Jev scoring cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Direct HTTP adapter for TypeSafe's System One API; the API key is supplied by the extension service worker. */
export class TypeSafeJevTransport implements JevTransport {
  private readonly fetcher: typeof fetch;

  constructor(private readonly apiKey: string, fetcher?: typeof fetch) {
    if (!apiKey.trim()) throw new Error("A TypeSafe API key is required.");
    // WorkerGlobalScope.fetch requires its global `this`; keep injected test fetchers untouched.
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async scorePassages(
    request: { query: string; passages: Array<{ id: string; headingPath: string[]; text: string; context?: string }> },
    signal?: AbortSignal
  ): Promise<Array<{ passageId: string; relevance: number }>> {
    if (!request.passages.length) return [];
    const passageIdByQuestion = new Map<string, string>();
    const questions: Record<string, TypeSafeQuestion> = {};
    const passages = request.passages.map((passage, index) => {
      const questionId = `passage_${index + 1}`;
      passageIdByQuestion.set(questionId, passage.id);
      questions[questionId] = {
        type: "score",
        instructions: {
          question: "How useful is this exact source passage as evidence for investigating the research query?",
          compare: ["`query`", `\`passages[${index}].heading\``, `\`passages[${index}].text\``, `\`passages[${index}].context\``],
          focus: "Judge the passage's relevance and evidential usefulness, not whether it agrees with the query's premise. Specific evidence that supports or contradicts the premise can both be highly relevant."
        },
        criteria: RELEVANCE_LEVELS
      };
      return {
        heading: passage.headingPath.join(" › "),
        text: passage.text,
        context: passage.context ?? ""
      };
    });
    const body = JSON.stringify({
      model: TYPESAFE_MODEL,
      state: { query: request.query, passages },
      questions
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const abortFromRun = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromRun, { once: true });

    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (controller.signal.aborted) throw new Error("Jev scoring cancelled or timed out.");
        response = await this.fetcher(TYPESAFE_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body,
          signal: controller.signal
        });
        if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
          await delay(retryAfterMs(response.headers.get("retry-after")) ?? RETRY_BASE_MS * (2 ** attempt), controller.signal);
          continue;
        }
        break;
      }

      if (!response) throw new Error("Jev API returned no response.");
      if (!response.ok) {
        throw new Error(`TypeSafe API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`);
      }
      const payload = await response.json() as TypeSafeResponse;
      if (!payload || typeof payload.answers !== "object" || payload.answers === null) {
        throw new Error("TypeSafe API response did not contain an answers object.");
      }
      return Array.from(passageIdByQuestion, ([questionId, passageId]) => {
        const answer = payload.answers?.[questionId];
        if (!answer || answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score)) return null;
        return { passageId, relevance: Math.max(0, Math.min(1, answer.score / (RELEVANCE_LEVELS.length - 1))) };
      }).filter((value): value is { passageId: string; relevance: number } => value !== null);
    } catch (error) {
      if (signal?.aborted) throw new Error("Jev scoring cancelled.");
      if (controller.signal.aborted) throw new Error(`Jev scoring timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromRun);
    }
  }
}
