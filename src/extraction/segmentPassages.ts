import type { ContentBlock, Passage } from "../models/types.js";
import { makeSourceText } from "./extractMainContent.js";

export interface SegmentOptions {
  mergeBelowChars: number;
  targetChars: number;
  hardMaxChars: number;
}

const DEFAULTS: SegmentOptions = { mergeBelowChars: 115, targetChars: 780, hardMaxChars: 1050 };

function splitLongText(text: string, hardMaxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > hardMaxChars) {
    const boundary = Math.max(
      rest.lastIndexOf(". ", hardMaxChars), rest.lastIndexOf("? ", hardMaxChars),
      rest.lastIndexOf("! ", hardMaxChars), rest.lastIndexOf("; ", hardMaxChars),
      rest.lastIndexOf(" ", hardMaxChars)
    );
    const cut = boundary > Math.floor(hardMaxChars * 0.55) ? boundary + (/[.!?;]/.test(rest[boundary] ?? "") ? 1 : 0) : hardMaxChars;
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export function segmentPassages(
  blocks: ContentBlock[],
  sourceId: string,
  url: string,
  documentHash: string,
  options: Partial<SegmentOptions> = {},
  sourceText = makeSourceText(blocks)
): Passage[] {
  const config = { ...DEFAULTS, ...options };
  const merged: ContentBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous && previous.headingPath.join("/") === block.headingPath.join("/") &&
        previous.text.length < config.mergeBelowChars && block.text.length < config.mergeBelowChars &&
        previous.text.length + block.text.length + 2 <= config.targetChars) {
        previous.text = `${previous.text}\n\n${block.text}`;
    } else {
      merged.push({ ...block, headingPath: [...block.headingPath] });
    }
  }
  const parts = merged.flatMap((block) => splitLongText(block.text, config.hardMaxChars).map((text) => ({ text, headingPath: block.headingPath })));
  let cursor = 0;
  const passages = parts.map(({ text, headingPath }, sourceIndex) => {
    const foundAt = sourceText.indexOf(text, cursor);
    const charStart = foundAt >= 0 ? foundAt : sourceText.indexOf(text);
    const charEnd = charStart + text.length;
    cursor = charEnd;
    const hasReliableOffset = charStart >= 0 && sourceText.length > 0;
    const sourcePositionNormalized = hasReliableOffset
      ? Math.max(0, Math.min(1, charStart / sourceText.length))
      : parts.length > 1 ? sourceIndex / (parts.length - 1) : 0;
    return {
      id: `${sourceId}:p${sourceIndex + 1}`,
      sourceId,
      url,
      headingPath,
      text,
      sourceIndex,
      charStart,
      charEnd,
      sourcePositionNormalized,
      sourcePositionMethod: hasReliableOffset ? "offset" as const : "sequence" as const,
      documentHash
    } satisfies Passage;
  });
  return passages.map((passage, index) => ({
    ...passage,
    previousText: passages[index - 1]?.text,
    nextText: passages[index + 1]?.text
  }));
}
