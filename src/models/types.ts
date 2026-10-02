export interface SearchQuery {
  text: string;
  normalized: string;
}

export interface SearchResult {
  id: string;
  url: string;
  title: string;
  domain: string;
  googleRank: number;
}

export interface ContentBlock {
  text: string;
  headingPath: string[];
  kind: "paragraph" | "list" | "quote";
}

export interface SourceDocument {
  sourceId: string;
  result: SearchResult;
  url: string;
  title: string;
  domain: string;
  faviconUrl?: string;
  documentHash: string;
  /** Preserved in the panel snapshot while the extracted source text is redacted. */
  documentLength?: number;
  sourceText: string;
  blocks: ContentBlock[];
  status: "complete" | "failed";
  error?: string;
}

export interface Passage {
  id: string;
  sourceId: string;
  url: string;
  headingPath: string[];
  text: string;
  previousText?: string;
  nextText?: string;
  sourceIndex: number;
  charStart: number;
  charEnd: number;
  sourcePositionNormalized?: number;
  sourcePositionMethod?: "offset" | "sequence";
  documentHash: string;
}

export interface PassageCandidate {
  passage: Passage;
  prefilterScore: number;
}

export type PassageRelation = "supports" | "contradicts" | "context" | "unclear" | "irrelevant";

export interface ScoredPassage {
  passage: Passage;
  relevance: number;
  globalRank?: number;
  /** Set only after the application validates the passage against its extracted source range. */
  provenanceVerified?: boolean;
  evidenceStrength?: number;
  relation?: PassageRelation;
  fusedRank?: number;
  scorerCount?: number;
}

export interface ResearchCandidateSet {
  frozen?: boolean;
  candidates: PassageCandidate[];
}

export interface SourceScore {
  sourceId: string;
  googleRank: number;
  researchRank: number;
  topPassage: ScoredPassage;
}

export type SourceLifecycle = "queued" | "fetching" | "extracting" | "segmenting" | "prefiltering" | "scoring" | "complete" | "failed";

export interface SourceProgress {
  result: SearchResult;
  status: SourceLifecycle;
  rawPassageCount: number;
  error?: string;
  document?: SourceDocument;
}

export interface ResearchRun {
  runId: string;
  query: SearchQuery;
  status: "queued" | "running" | "complete" | "cancelled" | "failed";
  hostPermissionNeeded?: boolean;
  hostPermissionOrigins?: string[];
  sources: SourceProgress[];
  evidence: ScoredPassage[];
  sourceScores: SourceScore[];
  candidateSet?: ResearchCandidateSet;
  scoring?: {
    mode: string;
    selectedScorerIds: string[];
    successfulScorerIds: string[];
    failedScorerIds: string[];
    fusion: { type: "rrf"; k: number; weights: Record<string, number> };
    addingScorers?: string[];
  };
  modelJudgments?: Record<string, ScoredPassage[]>;
}

export type ResearchRunView = Omit<ResearchRun, "candidateSet" | "modelJudgments"> & { canAddModels: boolean };

export interface ExtractedPage {
  title: string;
  canonicalUrl?: string;
  faviconUrl?: string;
  blocks: ContentBlock[];
}

export interface SearchResultProvider {
  getQuery(): SearchQuery;
  getResults(): SearchResult[];
}

export interface PassageScorer {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  score(query: string, passages: PassageCandidate[], signal?: AbortSignal): Promise<ScoredPassage[]>;
}
