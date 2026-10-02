import type { SearchQuery, SearchResult, SearchResultProvider } from "../models/types.js";

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
    const searchRoot = this.page.querySelector("#search") ?? this.page.body;
    if (!searchRoot) return [];
    const headings = Array.from(searchRoot.querySelectorAll("h3"));
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const heading of headings) {
      const anchor = heading.closest("a[href]") as HTMLAnchorElement | null;
      const container = heading.closest(".MjjYud") ?? heading.closest("div[data-hveid]") ?? heading.parentElement?.parentElement;
      if (!anchor || !container || container.closest("#tads, #tadsb, [data-text-ad], [aria-label*='Sponsored']")) continue;
      const label = `${container.getAttribute("aria-label") ?? ""} ${container.textContent ?? ""}`.slice(0, 500).toLowerCase();
      if (/\bsponsored\b|\badvertisement\b/.test(label)) continue;
      let url: URL;
      try { url = new URL(anchor.href, this.pageUrl); } catch { continue; }
      if (!/^https?:$/.test(url.protocol) || /(^|\.)google\.[^/]+$/i.test(url.hostname) || /google\.com\/aclk|\/url\?/.test(url.href)) continue;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|ved$|usg$|fbclid$)/i.test(key)) url.searchParams.delete(key);
      const canonical = url.href;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const title = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!title) continue;
      results.push({ id: `google-${results.length + 1}`, url: canonical, title, domain: url.hostname.replace(/^www\./, ""), googleRank: results.length + 1 });
    }
    return results;
  }
}
