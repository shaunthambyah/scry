import type { Passage, PassageCandidate } from "../models/types.js";

const STOP_WORDS = new Set("a an and are as at be but by can could did do does for from had has have how in into is it its may might of on or our should that the their then there these they this those through to was were what when where which who why will with would".split(" "));

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

function normalizedTerm(term: string): string {
  return term.toLowerCase().replace(/(ing|ed|es|s)$/, "");
}

function scorePassage(query: string, passage: Passage): number {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const text = `${passage.headingPath.join(" ")} ${passage.text}`.toLowerCase();
  const words = text.match(/[a-z0-9]+/g) ?? [];
  const wordSet = new Set(words.map(normalizedTerm));
  const matched = terms.filter((term) => wordSet.has(normalizedTerm(term)));
  const coverage = matched.length / terms.length;
  const frequency = matched.reduce((sum, term) => sum + Math.min(3, words.filter((word) => normalizedTerm(word) === normalizedTerm(term)).length), 0);
  const phrase = query.toLowerCase().split(/\s+/).filter((word) => word.length > 3).slice(0, 5).join(" ");
  const phraseBoost = phrase && text.includes(phrase) ? 0.18 : 0;
  return Math.min(1, coverage * 0.76 + Math.min(0.12, frequency * 0.018) + phraseBoost);
}

export function prefilterPassages(query: string, passages: Passage[], perPageLimit = 16): PassageCandidate[] {
  return passages.map((passage) => ({ passage, prefilterScore: scorePassage(query, passage) }))
    .filter((candidate) => candidate.prefilterScore > 0)
    .sort((a, b) => b.prefilterScore - a.prefilterScore || a.passage.sourceIndex - b.passage.sourceIndex)
    .slice(0, perPageLimit);
}
