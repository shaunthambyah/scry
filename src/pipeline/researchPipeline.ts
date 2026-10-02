import type { PassageCandidate, PassageScorer, ResearchRun, ScoredPassage, SearchResult, SourceDocument, SourceLifecycle } from "../models/types.js";
import { segmentPassages } from "../extraction/segmentPassages.js";
import { prefilterPassages } from "../ranking/prefilter.js";
import { deriveSourceScores } from "../ranking/pageScore.js";
import { compareEvidence, distinctSourcePassages, selectEvidenceForDisplay } from "../ranking/evidencePolicy.js";
import { rankScorerPassages, reciprocalRankFusion, RRF_CONFIG } from "../scoring/rankFusion.js";

export interface PipelineOptions {
  concurrency: number;
  perPageCandidateLimit: number;
  signal?: AbortSignal;
}

export interface SourceLoader {
  load(result: SearchResult, setStage: (stage: SourceLifecycle) => void, signal?: AbortSignal): Promise<SourceDocument>;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  concurrency: 4,
  perPageCandidateLimit: 16
};

function cloneCandidate(candidate: PassageCandidate): PassageCandidate {
  return { prefilterScore: candidate.prefilterScore, passage: { ...candidate.passage, headingPath: [...candidate.passage.headingPath] } };
}

export function createResearchRun(runId: string, query: ResearchRun["query"], results: SearchResult[]): ResearchRun {
  return {
    runId,
    query,
    status: "queued",
    sources: results.map((result) => ({ result, status: "queued", rawPassageCount: 0 })),
    evidence: [],
    sourceScores: []
  };
}

export function applyRunRanking(run: ResearchRun): void {
  const rankings = run.modelJudgments ?? {};
  const allScorerIds = Object.keys(rankings).filter((id) => (rankings[id]?.length ?? 0) > 0).sort();
  const realScorerIds = allScorerIds.filter((id) => id !== "mock");
  const scorerIds = realScorerIds.length && run.scoring?.mode !== "mock" ? realScorerIds : allScorerIds;
  const activeRankings = Object.fromEntries(scorerIds.map((id) => [id, rankings[id]]));
  if (scorerIds.length > 1 && run.candidateSet) {
    const result = reciprocalRankFusion.fuse(run.candidateSet.candidates, activeRankings, run.scoring?.fusion.weights);
    run.evidence = result.passages;
  } else if (scorerIds.length === 1) {
    const scorerId = scorerIds[0];
    const googleRanks = new Map(run.sources.map(({ result: source }) => [source.id, source.googleRank]));
    run.evidence = [...activeRankings[scorerId]].sort((a, b) => compareEvidence(a, b, googleRanks)).map((item) => ({ ...item, fusedRank: undefined }));
  }
  const googleRanks = new Map(run.sources.map(({ result: source }) => [source.id, source.googleRank]));
  run.evidence.sort((a, b) => a.fusedRank !== undefined && b.fusedRank !== undefined
    ? a.fusedRank - b.fusedRank
    : b.relevance - a.relevance || (googleRanks.get(a.passage.sourceId) ?? Number.MAX_SAFE_INTEGER) - (googleRanks.get(b.passage.sourceId) ?? Number.MAX_SAFE_INTEGER) || a.passage.id.localeCompare(b.passage.id));
  let displayCandidates: ScoredPassage[];
  if (scorerIds.length > 1) {
    const grouped = new Map<string, ScoredPassage[]>();
    for (const item of run.evidence) if (item.provenanceVerified === true) {
      const group = grouped.get(item.passage.sourceId) ?? [];
      group.push(item);
      grouped.set(item.passage.sourceId, group);
    }
    displayCandidates = [...grouped.values()].flatMap(distinctSourcePassages);
  } else displayCandidates = selectEvidenceForDisplay(run.evidence, run.sources);
  const isFused = scorerIds.length > 1;
  const ranks = new Map(displayCandidates.map((item, index) => [item.passage.id, isFused ? item.fusedRank ?? index + 1 : index + 1]));
  for (const item of run.evidence) {
    const rank = ranks.get(item.passage.id);
    if (rank === undefined) delete item.globalRank;
    else item.globalRank = rank;
  }
  run.sourceScores = deriveSourceScores(run.sources, run.evidence);
}

export async function scoreFrozenCandidates(
  run: ResearchRun,
  scorer: PassageScorer,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<{ error?: string }> {
  const candidateSet = run.candidateSet;
  if (!candidateSet?.frozen || !candidateSet.candidates.length) return { error: "Frozen candidates are unavailable for this session." };
  const bySource = new Map<string, PassageCandidate[]>();
  for (const candidate of candidateSet.candidates) {
    const group = bySource.get(candidate.passage.sourceId) ?? [];
    group.push(candidate);
    bySource.set(candidate.passage.sourceId, group);
  }
  const outputs = await Promise.allSettled([...bySource.values()].map((batch) => scorer.score(run.query.text, batch.map(cloneCandidate), signal)));
  if (!isCurrent() || signal.aborted) return { error: "Scoring was cancelled." };
  const canonical = new Map(candidateSet.candidates.map(({ passage }) => [passage.id, passage]));
  const accepted: ScoredPassage[] = [];
  let rejected: string | undefined;
  for (const output of outputs) {
    if (output.status === "rejected") { rejected = output.reason instanceof Error ? output.reason.message : String(output.reason); continue; }
    for (const item of output.value) {
      const passage = canonical.get(item.passage.id);
      if (!passage || !Number.isFinite(item.relevance)) continue;
      accepted.push({ ...item, passage, relevance: Math.max(0, Math.min(1, item.relevance)), provenanceVerified: true });
    }
  }
  if (accepted.length) {
    run.modelJudgments ??= {};
    run.modelJudgments[scorer.id] = rankScorerPassages(accepted);
    run.scoring ??= { mode: scorer.id, selectedScorerIds: [], successfulScorerIds: [], failedScorerIds: [], fusion: { type: "rrf", k: RRF_CONFIG.k, weights: {} } };
    run.scoring.selectedScorerIds = [...new Set([...run.scoring.selectedScorerIds, scorer.id])];
    run.scoring.successfulScorerIds = [...new Set([...run.scoring.successfulScorerIds, scorer.id])];
    run.scoring.fusion.weights[scorer.id] = RRF_CONFIG.defaultWeight;
  }
  return { error: rejected ?? (accepted.length ? undefined : "Scorer returned no valid passage judgments.") };
}

export async function processResearchRun(
  run: ResearchRun,
  loader: SourceLoader,
  scorers: PassageScorer | PassageScorer[],
  onUpdate: (run: ResearchRun) => void,
  isCurrent: () => boolean,
  options: Partial<PipelineOptions> = {}
): Promise<ResearchRun> {
  const config = { ...DEFAULT_PIPELINE_OPTIONS, ...options };
  const selectedScorers = Array.isArray(scorers) ? scorers : [scorers];
  run.status = "running";
  run.scoring ??= { mode: selectedScorers.length > 1 ? "consensus" : selectedScorers[0].id, selectedScorerIds: selectedScorers.map(({ id }) => id), successfulScorerIds: [], failedScorerIds: [], fusion: { type: "rrf", k: RRF_CONFIG.k, weights: Object.fromEntries(selectedScorers.map(({ id }) => [id, RRF_CONFIG.defaultWeight])) } };
  onUpdate(run);
  const canonicalDocuments = new Map<string, string>();

  const update = () => {
    if (!isCurrent()) return;
    applyRunRanking(run);
    onUpdate(run);
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < run.sources.length && isCurrent()) {
      const sourceIndex = nextIndex++;
      const progress = run.sources[sourceIndex];
      if (progress.status === "failed") { update(); continue; }
      try {
        const document = await loader.load(progress.result, (status) => {
          if (!isCurrent()) return;
          progress.status = status;
          update();
        }, config.signal);
        if (!isCurrent()) return;
        progress.document = document;
        const canonicalKey = (() => {
          try {
            const canonical = new URL(document.url);
            canonical.hash = "";
            return canonical.href;
          } catch { return document.url; }
        })();
        const earlierSource = canonicalDocuments.get(canonicalKey);
        if (earlierSource && earlierSource !== progress.result.id) {
          progress.status = "complete";
          update();
          continue;
        }
        canonicalDocuments.set(canonicalKey, progress.result.id);
        progress.status = "segmenting";
        update();
        const passages = segmentPassages(document.blocks, document.sourceId, document.url, document.documentHash, {}, document.sourceText);
        progress.rawPassageCount = passages.length;

        progress.status = "prefiltering";
        update();
        const candidates = prefilterPassages(run.query.text, passages, config.perPageCandidateLimit);
        run.candidateSet ??= { frozen: false, candidates: [] };
        const known = new Set(run.candidateSet.candidates.map(({ passage }) => passage.id));
        run.candidateSet.candidates.push(...candidates.filter(({ passage }) => !known.has(passage.id)));
        progress.status = "scoring";
        update();
      } catch (error) {
        if (!isCurrent()) return;
        progress.status = "failed";
        progress.error = error instanceof Error ? error.message : String(error);
      }
      update();
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));
  if (isCurrent() && !config.signal?.aborted) {
    if (run.candidateSet) run.candidateSet.frozen = true;
    const frozenCandidates = run.candidateSet?.candidates ?? [];
    update();
    const sourceCandidates = new Map<string, PassageCandidate[]>();
    for (const candidate of frozenCandidates) {
      const group = sourceCandidates.get(candidate.passage.sourceId) ?? [];
      group.push(candidate);
      sourceCandidates.set(candidate.passage.sourceId, group);
    }
    let nextScoreIndex = 0;
    const scoreWorker = async (): Promise<void> => {
      while (nextScoreIndex < run.sources.length && isCurrent()) {
        const progress = run.sources[nextScoreIndex++];
        const candidates = sourceCandidates.get(progress.result.id) ?? [];
        if (progress.status === "failed" || !candidates.length) {
          if (progress.status !== "failed") progress.status = "complete";
          update();
          continue;
        }
        progress.status = "scoring";
        const document = progress.document;
        try {
          const settled = await Promise.allSettled(selectedScorers.map((scorer) => scorer.score(run.query.text, candidates.map(cloneCandidate), config.signal)));
          if (!isCurrent()) return;
          run.modelJudgments ??= {};
          for (let scorerIndex = 0; scorerIndex < selectedScorers.length; scorerIndex += 1) {
            const scorer = selectedScorers[scorerIndex];
            const outcome = settled[scorerIndex];
            if (outcome.status === "rejected") {
              if (!run.scoring!.failedScorerIds.includes(scorer.id)) run.scoring!.failedScorerIds.push(scorer.id);
              continue;
            }
            const originalById = new Map(candidates.map(({ passage }) => [passage.id, passage]));
            const verified: ScoredPassage[] = [];
            for (const scored of outcome.value) {
              const sourcePassage = originalById.get(scored.passage.id);
              if (!document || !sourcePassage || !Number.isFinite(scored.relevance)) continue;
              const rangeMatches = document.sourceText.slice(sourcePassage.charStart, sourcePassage.charEnd) === sourcePassage.text;
              if (!rangeMatches || !document.sourceText.includes(sourcePassage.text) || sourcePassage.documentHash !== document.documentHash) {
                continue;
              }
              verified.push({ ...scored, passage: sourcePassage, relevance: Math.max(0, Math.min(1, scored.relevance)), provenanceVerified: true });
            }
            if (verified.length) {
              run.scoring!.failedScorerIds = run.scoring!.failedScorerIds.filter((id) => id !== scorer.id);
              run.modelJudgments[scorer.id] = rankScorerPassages([...(run.modelJudgments[scorer.id] ?? []), ...verified]);
              if (!run.scoring!.successfulScorerIds.includes(scorer.id)) run.scoring!.successfulScorerIds.push(scorer.id);
            } else if (!run.scoring!.failedScorerIds.includes(scorer.id)) run.scoring!.failedScorerIds.push(scorer.id);
          }
          progress.status = "complete";
        } catch (error) {
          progress.status = "failed";
          progress.error = error instanceof Error ? error.message : String(error);
        }
        update();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => scoreWorker()));
  }
  if (!isCurrent()) {
    run.status = "cancelled";
    return run;
  }
  applyRunRanking(run);
  run.status = "complete";
  onUpdate(run);
  return run;
}
