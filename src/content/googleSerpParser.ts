import type { SearchQuery, SearchResult, SearchResultProvider } from "../models/types.js";

function isGoogleGoto(url: URL): boolean {
  return /(^|\.)google\.[^/]+$/i.test(url.hostname) && url.pathname === "/goto" && url.searchParams.has("url");
}

export class GoogleSearchResultProvider implements SearchResultProvider {
  constructor(private readonly page: Document, private readonly pageUrl: string) {}

  getQuery(): SearchQuery {
    const input = this.page.querySelector<HTMLInputElement>('textarea[name="q"], input[name="q"]');
    let urlQuery = "";
    try { urlQuery = new URL(this.page.defaultView?.location.href ?? this.pageUrl).searchParams.get("q") ?? ""; } catch { /* use the search input */ }
    const text = (input?.value || input?.textContent || urlQuery).trim();
    return { text, normalized: text.toLowerCase().replace(/\s+/g, " ") };
  }

  getResults(): SearchResult[] {
    const searchRoot = this.page.querySelector("#rso") ?? this.page.querySelector("#search") ?? this.page.body;
    if (!searchRoot) return [];
    const headings = Array.from(this.page.querySelectorAll<HTMLElement>("h3, [role='heading'], .LC20lb, .DKV0Md"));
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const appendResult = (title: string, anchor: HTMLAnchorElement, container: Element): void => {
      if (!title || container.closest("#tads, #tadsb, [data-text-ad], [aria-label*='Sponsored']")) return;
      const label = `${container.getAttribute("aria-label") ?? ""} ${container.textContent ?? ""}`.slice(0, 500).toLowerCase();
      if (/\bsponsored\b|\badvertisement\b/.test(label)) return;
      let url: URL;
      try { url = new URL(anchor.href, this.pageUrl); } catch { return; }
      const googleHost = /(^|\.)google\.[^/]+$/i.test(url.hostname);
      if (!/^https?:$/.test(url.protocol) || (googleHost && !isGoogleGoto(url)) || /google\.com\/aclk|\/url\?/.test(url.href)) return;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|ved$|usg$|fbclid$)/i.test(key)) url.searchParams.delete(key);
      const canonical = url.href;
      if (seen.has(canonical)) return;
      seen.add(canonical);
      results.push({ id: `google-${results.length + 1}`, url: canonical, title, domain: url.hostname.replace(/^www\./, ""), googleRank: results.length + 1 });
    };
    for (const heading of headings) {
      const container = heading.closest(".MjjYud") ?? heading.closest("div[data-hveid]") ?? heading.closest("[data-sokoban-container]") ?? heading.parentElement?.parentElement ?? heading.parentElement;
      if (!container) continue;
      const headingAnchor = heading.closest<HTMLAnchorElement>("a[href]") ?? heading.querySelector<HTMLAnchorElement>("a[href]");
      const anchors = [...new Set([...(headingAnchor ? [headingAnchor] : []), ...container.querySelectorAll<HTMLAnchorElement>("a[href]")])];
      const title = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
      const matchingAnchor = anchors.find((candidate) => title && (candidate.textContent ?? "").replace(/\s+/g, " ").includes(title));
      const anchor = matchingAnchor ?? anchors.find((candidate) => {
        try {
          const url = new URL(candidate.href, this.pageUrl);
          const googleHost = /(^|\.)google\.[^/]+$/i.test(url.hostname);
          return /^https?:$/.test(url.protocol) && (!googleHost || isGoogleGoto(url)) && !/google\.com\/aclk|\/url\?/.test(url.href);
        } catch { return false; }
      });
      if (anchor) appendResult(title, anchor, container);
    }
    if (!results.length) {
      for (const anchor of searchRoot.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const title = (anchor.getAttribute("aria-label") || anchor.textContent || "").replace(/\s+/g, " ").trim();
        if (title.length < 4 || title.length > 180 || /^(read more|feedback|show more|more results)$/i.test(title)) continue;
        const container = anchor.closest(".MjjYud") ?? anchor.closest("div[data-hveid]") ?? anchor.closest("[data-sokoban-container]") ?? anchor.parentElement;
        if (container) appendResult(title, anchor, container);
      }
    }
    return results;
  }
}
