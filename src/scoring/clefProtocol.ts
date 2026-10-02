export type ClefModel = "clef" | "clef-flash";

export interface ClefPassageInput {
  id: string;
  heading: string;
  text: string;
  previous?: string;
  next?: string;
}

export interface ClefScoringRequest {
  model: ClefModel;
  query: string;
  passages: ClefPassageInput[];
}

export interface ClefScoringResponse {
  model: ClefModel;
  answers: Record<string, { relevance: number }>;
}

export const CLEF_BATCH_SIZE = 32;
export const CLEF_MAX_QUESTIONS = 64;
export const CLEF_QUESTION_INSTRUCTION = "Would this exact passage provide substantive, directly useful evidence for a researcher investigating the query? Judge information that addresses the need, not keyword overlap, navigation, boilerplate, or generic context.";

export function createClefQuestions(passages: readonly ClefPassageInput[]): Record<string, { type: "noul"; instructions: string }> {
  if (!passages.length || passages.length > CLEF_MAX_QUESTIONS) throw new Error(`Clef requests must contain 1–${CLEF_MAX_QUESTIONS} passages.`);
  return Object.fromEntries(passages.map((passage, index) => [`relevance_${index + 1}`, {
    type: "noul" as const,
    instructions: `${CLEF_QUESTION_INSTRUCTION} Evaluate only passage id ${passage.id} in state.passages.`
  }]));
}

export function validateClefProbability(value: unknown, id: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Clef returned an invalid relevance probability for ${id}.`);
  }
  return value;
}


export function createClefBatches<T extends ClefPassageInput>(
  query: string,
  passages: readonly T[],
  batchSize = CLEF_BATCH_SIZE,
  maxBytes = 42_000
): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > CLEF_MAX_QUESTIONS) throw new Error("Clef batch size must be between 1 and 64.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Clef maximum request size must be positive.");
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const passage of passages) {
    const singleBytes = new TextEncoder().encode(JSON.stringify({ query, passages: [passage] })).byteLength;
    if (singleBytes > maxBytes) throw new Error(`Passage ${passage.id} exceeds the Clef batch size limit.`);
    const candidateBatch = [...batch, passage];
    const bytes = new TextEncoder().encode(JSON.stringify({ query, passages: candidateBatch })).byteLength;
    if (bytes > maxBytes && batch.length === 0) throw new Error(`Passage ${passage.id} exceeds the Clef batch size limit.`);
    if (batch.length >= batchSize || (bytes > maxBytes && batch.length > 0)) {
      batches.push(batch);
      batch = [passage];
    } else batch = candidateBatch;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
