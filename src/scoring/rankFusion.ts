import type { PassageCandidate, ScoredPassage } from "../models/types.js";

export interface RankFusionStrategy {
  readonly id: string;
  fuse(candidates: PassageCandidate[], rankings: Record<string, ScoredPassage[]>, weights?: Record<string, number>): FusedRanking;
}

export interface FusedRanking {
  passages: ScoredPassage[];
}

export const RRF_CONFIG = {
  k: 60,
  defaultWeight: 1
} as const;

/** Stable model rank ordering used before rank fusion. */
export function rankScorerPassages(items: readonly ScoredPassage[]): ScoredPassage[] {
  const strongest = new Map<string, ScoredPassage>();
  for (const item of items) {
    const previous = strongest.get(item.passage.id);
    if (!previous || item.relevance > previous.relevance) strongest.set(item.passage.id, item);
  }
  return [...strongest.values()].sort((a, b) =>
    b.relevance - a.relevance || a.passage.sourceIndex - b.passage.sourceIndex || a.passage.id.localeCompare(b.passage.id)
  );
}

export class ReciprocalRankFusion implements RankFusionStrategy {
  readonly id = "rrf";

  constructor(readonly k = RRF_CONFIG.k) {
    if (!Number.isFinite(k) || k <= 0) throw new Error("RRF k must be a positive number.");
  }

  fuse(candidates: PassageCandidate[], rankings: Record<string, ScoredPassage[]>, weights: Record<string, number> = {}): FusedRanking {
    const candidateById = new Map(candidates.map(({ passage }) => [passage.id, passage]));
    const fused = new Map<string, { score: number; votes: number; bestRank: number }>();

    for (const [scorerId, results] of Object.entries(rankings).sort(([a], [b]) => a.localeCompare(b))) {
      const valid = rankScorerPassages(results.filter((item) => candidateById.has(item.passage.id) && Number.isFinite(item.relevance)));
      const weight = Number.isFinite(weights[scorerId]) ? weights[scorerId] : RRF_CONFIG.defaultWeight;
      valid.forEach((item, index) => {
        const rank = index + 1;
        const id = item.passage.id;
        const value = fused.get(id) ?? { score: 0, votes: 0, bestRank: Number.MAX_SAFE_INTEGER };
        value.score += weight / (this.k + rank);
        value.votes += 1;
        value.bestRank = Math.min(value.bestRank, rank);
        fused.set(id, value);
      });
    }

    const orderedIds = [...fused].sort(([idA, a], [idB, b]) =>
      b.score - a.score || b.votes - a.votes || a.bestRank - b.bestRank || idA.localeCompare(idB)
    ).map(([id]) => id);
    const passages = orderedIds.map((id, index) => {
      const base = candidateById.get(id)!;
      const value = fused.get(id)!;
      const fusedRank = index + 1;
      // Bounded, monotonic rank utility feeds the existing diminishing-return source aggregator.
      // It is an ordering utility, not a probability or a rescaled raw RRF score.
      const rankUtility = 1 / Math.log2(fusedRank + 1);
      return {
        passage: base,
        relevance: rankUtility,
        fusedRank,
        scorerCount: value.votes,
        provenanceVerified: true
      } satisfies ScoredPassage;
    });
    return { passages };
  }
}

export const reciprocalRankFusion = new ReciprocalRankFusion(RRF_CONFIG.k);
