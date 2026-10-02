import type { ScoredPassage, SourceProgress, SourceScore } from "../models/types.js";
import { distinctSourcePassages } from "./evidencePolicy.js";

export const SOURCE_RANK_CONFIG = {
  passageWeights: [1, 0.20, 0.10, 0.05, 0.025] as const,
  maxPassages: 5
} as const;

export function deriveSourceScores(sources: SourceProgress[], evidence: ScoredPassage[]): SourceScore[] {
  const ranked = sources.flatMap((source) => {
    const scored = evidence.filter((item) => item.passage.sourceId === source.result.id);
    const useful = distinctSourcePassages(scored.filter((item) => item.relation !== "irrelevant" && item.provenanceVerified !== false));
    if (!useful.length) return [];
    const topPassages = useful.slice(0, SOURCE_RANK_CONFIG.maxPassages);
    const orderingValue = Number(topPassages.reduce((sum, item, index) => sum + item.relevance * SOURCE_RANK_CONFIG.passageWeights[index], 0).toFixed(6));
    return [{
      sourceId: source.result.id,
      googleRank: source.result.googleRank,
      researchRank: 0,
      orderingValue,
      topPassage: topPassages[0]
    }];
  }).sort((a, b) => b.orderingValue - a.orderingValue || a.googleRank - b.googleRank);
  return ranked.map(({ orderingValue: _orderingValue, ...score }, index) => ({ ...score, researchRank: index + 1 }));
}
