import type { ContentBlock, ExtractedPage } from "../models/types.js";
import { Readability } from "@mozilla/readability";

const REMOVE_SELECTOR = [
  "script", "style", "noscript", "svg", "canvas", "iframe", "form", "nav", "footer", "body > header", "[role=banner]", "aside",
  "[role=navigation]", "[role=menu]", "[role=complementary]", "[aria-modal=true]",
  ".advertisement", ".ads", ".cookie", ".consent", ".newsletter", ".related", ".recommendations",
  ".social-share", ".paywall", "#cookie-banner", "#comments"
].join(",");

function visibleText(element: Element | null | undefined): string {
  if (!element) return "";
  return (element.textContent ?? "").replace(/[\t\r\f\v ]+/g, " ").replace(/\n+/g, " ").trim();
}

function isFurniture(element: Element): boolean {
  const identity = `${element.id} ${element.className?.toString?.() ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
  return /cookie|consent|newsletter|subscribe|related|recommend|advert|breadcrumb|social-share|share-tools|navigation/.test(identity);
}

function contentScore(element: Element): number {
  const paragraphs = Array.from(element.querySelectorAll("p, blockquote, li"));
  let score = 0;
  for (const paragraph of paragraphs) {
    const text = visibleText(paragraph);
    if (text.length < 35 || isFurniture(paragraph)) continue;
    const links = Array.from(paragraph.querySelectorAll("a")).reduce((sum, link) => sum + visibleText(link).length, 0);
    const linkRatio = links / Math.max(1, text.length);
    score += Math.min(text.length, 800) * (1 - Math.min(0.9, linkRatio)) + 20;
  }
  return score;
}

function candidateScore(element: Element): number {
  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role");
  const semanticBonus = tag === "article" ? 180 : tag === "main" ? 120 : role === "main" ? 140 : 0;
  return contentScore(element) + semanticBonus;
}

function chooseRoot(document: Document): Element {
  const preferred = Array.from(document.querySelectorAll("article, main, [role=main]")).filter((node) => !isFurniture(node));
  const viablePreferred = preferred.filter((node) => contentScore(node) > 0);
  const candidates = viablePreferred.length ? viablePreferred : Array.from(document.querySelectorAll("#content, #main, .content, .article, body"));
  let best: Element = candidates[0] ?? document.body ?? document.documentElement;
  let bestScore = candidateScore(best);
  for (const candidate of candidates) {
    const score = candidateScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function blocksFromRoot(root: Element): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const headings: string[] = [];
  const seenText = new Set<string>();
  const nodes = Array.from(root.querySelectorAll("h1, h2, h3, p, li, blockquote"));

  for (const node of nodes) {
    if (isFurniture(node) || node.closest(REMOVE_SELECTOR)) continue;
    const text = visibleText(node);
    const tag = node.tagName.toLowerCase();
    const isHeading = /^h[1-3]$/.test(tag);
    if (!text || (!isHeading && text.length < 18) || seenText.has(text)) continue;
    seenText.add(text);
    if (isHeading) {
      const level = Number(tag[1]);
      headings.length = Math.max(0, level - 1);
      headings[level - 1] = text;
      continue;
    }
    // Nested list paragraphs and list items otherwise duplicate the same source text.
    if (tag === "p" && node.closest("li")) continue;
    const kind: ContentBlock["kind"] = tag === "li" ? "list" : tag === "blockquote" ? "quote" : "paragraph";
    blocks.push({ text, headingPath: headings.filter(Boolean), kind });
  }
  return blocks;
}

function sourceFaviconUrl(document: Document, pageUrl: string): string | undefined {
  try {
    const page = new URL(pageUrl);
    const declared = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.getAttribute("href");
    if (declared) {
      const candidate = new URL(declared, page);
      if (/^https?:$/.test(candidate.protocol) && candidate.origin === page.origin) return candidate.href;
    }
    return new URL("/favicon.ico", page).href;
  } catch {
    return undefined;
  }
}

/** Parse in an extension document with DOMParser; emitted block text is the immutable evidence basis. */
export function extractMainContent(html: string, pageUrl: string, parser: DOMParser = new DOMParser()): ExtractedPage {
  const document = parser.parseFromString(html, "text/html");
  const originalTitle = visibleText(document.querySelector("h1")) || visibleText(document.querySelector("title")) || new URL(pageUrl).hostname;
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  let readabilityArticle: ReturnType<Readability["parse"]> = null;
  try {
    const clone = document.cloneNode(true) as Document;
    readabilityArticle = new Readability(clone, { disableJSONLD: true }).parse();
  } catch {
    // Fall back to the local structural heuristic for malformed or unusual DOMs.
  }
  if (readabilityArticle?.content) {
    try {
      const articleDocument = parser.parseFromString(readabilityArticle.content, "text/html");
      const blocks = blocksFromRoot(articleDocument.body);
      if (blocks.length && blocks.map((block) => block.text).join(" ").length >= 100) {
        return {
          title: readabilityArticle.title || originalTitle,
          canonicalUrl: canonical ? new URL(canonical, pageUrl).href : undefined,
          faviconUrl: sourceFaviconUrl(document, pageUrl),
          blocks
        };
      }
    } catch {
      // Keep the source parser independent of Readability's serialized HTML details.
    }
  }

  for (const node of Array.from(document.querySelectorAll(REMOVE_SELECTOR))) node.remove();
  const root = chooseRoot(document);
  return {
    title: originalTitle,
    canonicalUrl: canonical ? new URL(canonical, pageUrl).href : undefined,
    faviconUrl: sourceFaviconUrl(document, pageUrl),
    blocks: blocksFromRoot(root)
  };
}

export function makeSourceText(blocks: ContentBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}
