export interface EvidenceAnchorPayload {
  runId: string;
  passageId: string;
  text: string;
  previousText?: string;
  nextText?: string;
}

export interface EvidenceAnchorResult {
  found: boolean;
  reason?: string;
}

/** This function is injected into the opened source tab; keep all implementation inside it. */
export function locateAndHighlightEvidence(payload: EvidenceAnchorPayload): EvidenceAnchorResult {
  const body = document.body ?? document.documentElement;
  if (!body) return { found: false, reason: "document-body-unavailable" };
  const registry = (window.CSS as typeof CSS & { highlights?: { set(name: string, highlight: unknown): void; delete(name: string): boolean } } | undefined)?.highlights;
  // A tab represents one current reading position. Clear the previous Scry target
  // before searching so a failed/new selection cannot leave a stale passage marked.
  registry?.delete("jev-evidence-active");
  registry?.delete("jev-evidence-persistent");

  type TextPosition = { node: Text; offset: number };
  const normalized: string[] = [];
  const positions: Array<{ start: TextPosition; end: TextPosition }> = [];
  let pendingSpace: { start: TextPosition; end: TextPosition } | null = null;
  const excludedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "BUTTON"]);
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue ?? "";
      if (!value) return NodeFilter.FILTER_REJECT;
      let parent = node.parentElement;
      while (parent && parent !== body.parentElement) {
        if (excludedTags.has(parent.tagName) || parent.hasAttribute("hidden") || parent.getAttribute("aria-hidden") === "true" || parent.hasAttribute("data-jev-evidence-highlight")) {
          return NodeFilter.FILTER_REJECT;
        }
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return NodeFilter.FILTER_REJECT;
        if (parent === body) break;
        parent = parent.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    const value = node.data;
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset];
      if (/\s/.test(character)) {
        if (normalized.length) {
          const point = { node, offset };
          pendingSpace = pendingSpace
            ? { start: pendingSpace.start, end: { node, offset: offset + 1 } }
            : { start: point, end: { node, offset: offset + 1 } };
        }
        continue;
      }
      if (normalized.length && pendingSpace) {
        normalized.push(" ");
        positions.push(pendingSpace);
      }
      pendingSpace = null;
      normalized.push(character);
      positions.push({ start: { node, offset }, end: { node, offset: offset + 1 } });
    }
  }

  const sourceText = payload.text.replace(/\s+/g, " ").trim();
  if (!sourceText) return { found: false, reason: "empty-passage" };
  const pageText = normalized.join("");
  const prefix = (payload.previousText ?? "").replace(/\s+/g, " ").trim().slice(-96);
  const suffix = (payload.nextText ?? "").replace(/\s+/g, " ").trim().slice(0, 96);
  const matches: number[] = [];
  let from = 0;
  while (true) {
    const at = pageText.indexOf(sourceText, from);
    if (at < 0) break;
    matches.push(at);
    from = at + 1;
  }
  if (!matches.length) return { found: false, reason: "exact-passage-not-found" };

  function commonSuffixLength(first: string, second: string): number {
    let count = 0;
    while (count < first.length && count < second.length && first[first.length - count - 1] === second[second.length - count - 1]) count += 1;
    return count;
  }
  function commonPrefixLength(first: string, second: string): number {
    let count = 0;
    while (count < first.length && count < second.length && first[count] === second[count]) count += 1;
    return count;
  }
  const rankedMatches = matches.map((at, occurrence) => {
    const before = pageText.slice(Math.max(0, at - prefix.length), at);
    const after = pageText.slice(at + sourceText.length, at + sourceText.length + suffix.length);
    const contextScore = (prefix ? commonSuffixLength(prefix, before) : 0) + (suffix ? commonPrefixLength(suffix, after) : 0);
    return { at, occurrence, contextScore };
  }).sort((first, second) => second.contextScore - first.contextScore || first.occurrence - second.occurrence);
  const selected = rankedMatches[0];
  const start = positions[selected.at];
  const end = positions[selected.at + sourceText.length - 1];
  if (!start || !end) return { found: false, reason: "text-range-unavailable" };

  const range = document.createRange();
  range.setStart(start.start.node, start.start.offset);
  range.setEnd(end.end.node, end.end.offset);
  const HighlightConstructor = (window as Window & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightConstructor) return { found: false, reason: "css-highlight-unavailable" };

  const styleId = "jev-evidence-highlight-style";
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    style.setAttribute("data-jev-evidence-highlight", "true");
    (document.head ?? body).append(style);
  }
  style.textContent = "::highlight(jev-evidence-active) { background: rgba(92, 126, 143, .26); }";

  const targetElement = start.start.node.parentElement;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (targetElement && typeof targetElement.scrollIntoView === "function") {
    targetElement.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  }
  const highlight = new HighlightConstructor(range);
  registry.set("jev-evidence-active", highlight);
  return { found: true };
}
