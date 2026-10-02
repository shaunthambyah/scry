import type { ScoredPassage } from "../models/types.js";

export interface CoverageSegment {
  start: number;
  end: number;
  width: number;
  passageIds: string[];
  primaryPassageId: string;
  globalRank: number;
  relevance: number;
  positionMethod: "offset" | "sequence";
}

interface PassageSpan extends CoverageSegment {
  passageWidth: number;
}

const clamp = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, value));
const ADJACENT_GAP = 0.002;
const HEAVY_OVERLAP_RATIO = 0.65;

/**
 * Maps relevant passages onto the source document. Verified offsets are exact;
 * missing offsets use source order and text length against an estimated length.
 * Nearby or substantially overlapping passages share one clickable section.
 */
export function evidenceCoverageSegments(
  passages: ScoredPassage[],
  documentLength = 0,
  sourcePassageCount = passages.length
): CoverageSegment[] {
  if (!passages.length) return [];
  const meanPassageLength = passages.reduce((sum, item) => sum + Math.max(1, item.passage.text.length), 0) / passages.length;
  const maxSourceIndex = Math.max(-1, ...passages.map(({ passage }) => passage.sourceIndex));
  const passageCount = Math.max(1, sourcePassageCount, passages.length, maxSourceIndex + 1);
  const estimatedDocumentLength = Math.max(1, documentLength || meanPassageLength * passageCount);

  const spans: PassageSpan[] = passages.map((item, index) => {
    const passage = item.passage;
    const validOffset = documentLength > 0
      && passage.sourcePositionMethod !== "sequence"
      && Number.isFinite(passage.charStart)
      && Number.isFinite(passage.charEnd)
      && passage.charStart >= 0
      && passage.charEnd > passage.charStart;
    const method: "offset" | "sequence" = validOffset ? "offset" : "sequence";
    const rawStart = validOffset ? passage.charStart / documentLength : passage.sourceIndex / passageCount;
    const rawWidth = validOffset
      ? (passage.charEnd - passage.charStart) / documentLength
      : Math.max(1, passage.text.length) / estimatedDocumentLength;
    const start = clamp(rawStart);
    const end = clamp(start + Math.max(0.0001, rawWidth));
    const globalRank = item.globalRank ?? index + 1;
    return {
      start,
      end: Math.max(start, end),
      width: Math.max(0, end - start),
      passageIds: [passage.id],
      primaryPassageId: passage.id,
      globalRank,
      relevance: item.relevance,
      positionMethod: method,
      passageWidth: Math.max(0.0001, end - start)
    };
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.globalRank - b.globalRank);

  const merged: PassageSpan[] = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push(span);
      continue;
    }
    const gap = span.start - previous.end;
    const overlap = Math.max(0, previous.end - span.start);
    const overlapRatio = overlap / Math.max(0.0001, Math.min(previous.passageWidth, span.passageWidth));
    if (gap > ADJACENT_GAP && overlapRatio < HEAVY_OVERLAP_RATIO) {
      merged.push(span);
      continue;
    }

    previous.start = Math.min(previous.start, span.start);
    previous.end = Math.max(previous.end, span.end);
    previous.width = previous.end - previous.start;
    previous.passageIds.push(...span.passageIds);
    previous.passageWidth = previous.end - previous.start;
    previous.positionMethod = previous.positionMethod === "offset" && span.positionMethod === "offset" ? "offset" : "sequence";
    if (span.relevance > previous.relevance || (span.relevance === previous.relevance && span.globalRank < previous.globalRank)) {
      previous.primaryPassageId = span.primaryPassageId;
      previous.globalRank = span.globalRank;
      previous.relevance = span.relevance;
    }
  }

  return merged.map(({ passageWidth: _passageWidth, ...segment }) => segment);
}
