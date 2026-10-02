import type { ScoredPassage, SourceProgress } from "../models/types.js";

export const EVIDENCE_DISPLAY_CONFIG = {
  initialLimit: 20,
  provenanceFaviconLimit: 5
} as const;

export function relevancePercent(relevance: number): number {
  return Math.round(Math.max(0, Math.min(1, relevance)) * 100);
}

function normalizedText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function nearIdentical(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 100) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.96;
}

function rangesOverlap(a: ScoredPassage, b: ScoredPassage): boolean {
  const first = a.passage;
  const second = b.passage;
  return Number.isFinite(first.charStart) && Number.isFinite(first.charEnd) &&
    Number.isFinite(second.charStart) && Number.isFinite(second.charEnd) &&
    first.charStart < second.charEnd && second.charStart < first.charEnd;
}

function relevanceOrder(a: ScoredPassage, b: ScoredPassage): number {
  return b.relevance - a.relevance || a.passage.sourceIndex - b.passage.sourceIndex || a.passage.id.localeCompare(b.passage.id);
}

/** Keep the strongest representative when one source produced duplicate or overlapping passages. */
export function distinctSourcePassages(passages: ScoredPassage[]): ScoredPassage[] {
  const ordered = [...passages].sort(relevanceOrder);
  const retained: ScoredPassage[] = [];
  const retainedText: string[] = [];
  for (const item of ordered) {
    const text = normalizedText(item.passage.text);
    const duplicate = retained.some((other, index) =>
      nearIdentical(text, retainedText[index]) || rangesOverlap(item, other)
    );
    if (!duplicate) {
      retained.push(item);
      retainedText.push(text);
    }
  }
  return retained;
}

/** Normal-view evidence excludes unverified and explicitly irrelevant items, then collapses same-source duplicates. */
export function selectEvidenceForDisplay(evidence: ScoredPassage[], sources: SourceProgress[]): ScoredPassage[] {
  const ranks = new Map(sources.map(({ result }) => [result.id, result.googleRank]));
  const grouped = new Map<string, ScoredPassage[]>();
  for (const item of evidence) {
    if (item.provenanceVerified !== true || item.relation === "irrelevant") continue;
    const group = grouped.get(item.passage.sourceId) ?? [];
    group.push(item);
    grouped.set(item.passage.sourceId, group);
  }
  return [...grouped.values()].flatMap(distinctSourcePassages).sort((a, b) => compareEvidence(a, b, ranks));
}

/** Raw relevance is primary; evidence strength and original Google rank break only exact score ties. */
export function compareEvidence(a: ScoredPassage, b: ScoredPassage, googleRanks: Map<string, number> = new Map()): number {
  const relevance = b.relevance - a.relevance;
  if (relevance) return relevance;
  const strength = (b.evidenceStrength ?? 0) - (a.evidenceStrength ?? 0);
  if (strength) return strength;
  const googleRank = (googleRanks.get(a.passage.sourceId) ?? Number.MAX_SAFE_INTEGER) -
    (googleRanks.get(b.passage.sourceId) ?? Number.MAX_SAFE_INTEGER);
  if (googleRank) return googleRank;
  return a.passage.sourceIndex - b.passage.sourceIndex || a.passage.id.localeCompare(b.passage.id);
}
