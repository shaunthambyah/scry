export interface EvidenceTextTarget {
  text: string;
  previousText?: string;
  nextText?: string;
}

function normalizeFragmentText(value: string): string {
  return value.replace(/[\t\n\r\f\v\u00a0]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function startPhrase(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const boundary = value.lastIndexOf(" ", maximum);
  return value.slice(0, boundary > maximum * 0.65 ? boundary : maximum).trimEnd();
}

function endPhrase(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const boundary = value.indexOf(" ", value.length - maximum);
  return value.slice(boundary >= 0 && boundary < value.length - maximum * 0.35 ? boundary + 1 : value.length - maximum).trimStart();
}

function encodeDirectiveText(value: string): string {
  // Hyphens delimit text-fragment prefix/suffix syntax, so encode source hyphens within phrases.
  return encodeURIComponent(value).replace(/-/g, "%2D");
}

/** Builds a compact native Text Fragment selector, preserving any ordinary page anchor. */
export function evidenceTextFragmentUrl(sourceUrl: string, target: EvidenceTextTarget): string {
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== "http:" && source.protocol !== "https:") return sourceUrl;
    const text = normalizeFragmentText(target.text);
    if (!text) return source.href;

    const start = startPhrase(text, 72);
    const end = text.length > 140 ? endPhrase(text, 56) : "";
    const prefixText = normalizeFragmentText(target.previousText ?? "");
    const suffixText = normalizeFragmentText(target.nextText ?? "");
    const prefix = prefixText ? endPhrase(prefixText, 36) : "";
    const suffix = suffixText ? startPhrase(suffixText, 36) : "";
    const selector = `${prefix ? `${encodeDirectiveText(prefix)}-,` : ""}${encodeDirectiveText(start)}${end ? `,${encodeDirectiveText(end)}` : ""}${suffix ? `,-${encodeDirectiveText(suffix)}` : ""}`;

    const existingAnchor = source.hash.slice(1).split(":~:")[0];
    const hash = existingAnchor ? `#${existingAnchor}:~:text=${selector}` : `#:~:text=${selector}`;
    return `${source.href.split("#")[0]}${hash}`;
  } catch {
    return sourceUrl;
  }
}
