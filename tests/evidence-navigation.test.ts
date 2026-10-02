import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { activateOrCreateSourceTab, chooseExistingSourceTab, openOrReuseAndAnchor, sourceIdentity, type SourceBrowserTab, type SourceTabsApi } from "../src/background/sourceTabs.js";
import { locateAndHighlightEvidence, type EvidenceAnchorPayload, type EvidenceAnchorResult } from "../src/content/evidenceAnchor.js";
import { evidenceTextFragmentUrl } from "../src/sidepanel/evidenceNavigation.js";

test("Text Fragment targets stay compact, encode exact source phrases, add context, and preserve ordinary anchors", () => {
  const body = "The excerpt begins with a distinctive result. It then explains how the experiment held model weights fixed while allocating additional inference compute to reasoning tasks. The closing sentence records the measured outcome and its limitation.";
  const href = evidenceTextFragmentUrl("https://research.example/paper#methods", {
    previousText: "The authors described the measurement protocol.",
    text: body,
    nextText: "The following section compares the other benchmark results."
  });
  assert.ok(href.startsWith("https://research.example/paper#methods:~:text="));
  const selector = href.slice(href.indexOf("text=") + "text=".length);
  assert.ok(selector.includes(","), "selector retains Text Fragment's start/end delimiter");
  assert.match(selector, /-,/);
  assert.match(selector, /,-/);
  assert.ok(selector.length < 300, "the native target remains bounded for long source passages");
  assert.ok(href.includes(encodeURIComponent("The excerpt begins")));
  assert.equal(evidenceTextFragmentUrl("javascript:alert(1)", { text: "safe source wording" }), "javascript:alert(1)");
});

test("fallback finds exact text across DOM nodes, chooses the occurrence with matching context, and highlights it", () => {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><main>
    <p>Unique lead. The same <strong>exact evidence line</strong> appears here. Unique tail.</p>
    <p>Common lead. The same exact evidence line appears here. General tail.</p>
  </main></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window;
  const highlights = new Map<string, unknown>();
  const scrollOptions: Array<{ behavior?: string; block?: string }> = [];
  Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: { set: (name: string, value: unknown) => highlights.set(name, value), delete: (name: string) => highlights.delete(name) } } });
  window.eval("window.Highlight = class Highlight { constructor(...ranges) { this.ranges = ranges; } }");
  Object.defineProperty(window.Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ top: 160, height: 24, left: 0, right: 100, bottom: 184, width: 100, x: 0, y: 160, toJSON: () => ({}) }) });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(window.Element.prototype, "scrollIntoView", { configurable: true, value: (options: { behavior?: string; block?: string }) => scrollOptions.push(options) });
  const inject = window.eval(`(${locateAndHighlightEvidence.toString()})`) as (payload: EvidenceAnchorPayload) => EvidenceAnchorResult;
  const result = inject({
    runId: "run",
    passageId: "source:p1",
    previousText: "Unique lead.",
    text: "The same exact evidence line appears here.",
    nextText: "Unique tail."
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { found: true });
  assert.deepEqual(JSON.parse(JSON.stringify(scrollOptions[0])), { behavior: "smooth", block: "center" });
  assert.ok(highlights.has("jev-evidence-active"));
  assert.equal(highlights.has("jev-evidence-persistent"), false);
  const firstHighlight = highlights.get("jev-evidence-active");
  const second = inject({ runId: "run", passageId: "source:p2", text: "Unique tail." });
  assert.equal(second.found, true);
  assert.equal(highlights.size, 1, "only the currently selected Scry passage remains highlighted");
  assert.notEqual(highlights.get("jev-evidence-active"), firstHighlight);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  inject({ runId: "run", passageId: "source:p3", text: "Unique lead." });
  assert.deepEqual(JSON.parse(JSON.stringify(scrollOptions[2])), { behavior: "auto", block: "center" }, "reduced-motion preferences avoid smooth scrolling");
  assert.doesNotMatch(window.document.querySelector("#jev-evidence-highlight-style")?.textContent ?? "", /text-decoration|underline|color:/i);
  dom.window.close();
});

test("fallback refuses to highlight text that is not present verbatim", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body><p>Only real source words appear here.</p></body></html>", { runScripts: "outside-only" });
  const highlights = new Map<string, unknown>([["jev-evidence-active", { old: true }]]);
  Object.defineProperty(dom.window, "CSS", { configurable: true, value: { highlights: { set: (name: string, value: unknown) => highlights.set(name, value), delete: (name: string) => highlights.delete(name) } } });
  const inject = dom.window.eval(`(${locateAndHighlightEvidence.toString()})`) as (payload: EvidenceAnchorPayload) => EvidenceAnchorResult;
  const result = inject({ runId: "run", passageId: "source:p1", text: "Generated text that does not occur in the source." });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { found: false, reason: "exact-passage-not-found" });
  assert.equal(highlights.size, 0, "a missing new target clears the prior Scry highlight instead of leaving it stale");
  dom.window.close();
});

function tabsApi(initialTabs: SourceBrowserTab[] = []): SourceTabsApi & {
  tabs: SourceBrowserTab[];
  created: Array<{ url: string; active: true; windowId?: number }>;
  updates: Array<{ tabId: number; properties: { active: true } }>;
  focusedWindows: number[];
  complete: (tabId: number, url?: string) => void;
  listeners: Set<Parameters<SourceTabsApi["onUpdated"]["addListener"]>[0]>;
} {
  const tabs = initialTabs.map((tab) => ({ ...tab }));
  const created: Array<{ url: string; active: true; windowId?: number }> = [];
  const updates: Array<{ tabId: number; properties: { active: true } }> = [];
  const focusedWindows: number[] = [];
  const listeners = new Set<Parameters<SourceTabsApi["onUpdated"]["addListener"]>[0]>();
  let nextId = Math.max(100, ...tabs.map(({ id }) => id ?? 0)) + 1;
  return {
    tabs,
    created,
    updates,
    focusedWindows,
    listeners,
    query: async () => tabs.map((tab) => ({ ...tab })),
    create: async (properties) => {
      created.push(properties);
      const tab: SourceBrowserTab = { id: nextId++, windowId: properties.windowId, url: properties.url, active: true, status: "loading", index: tabs.length };
      tabs.push(tab);
      return { ...tab };
    },
    update: async (tabId, properties) => {
      updates.push({ tabId, properties });
      const tab = tabs.find(({ id }) => id === tabId);
      if (!tab) throw new Error("missing tab");
      for (const other of tabs) if (other.windowId === tab.windowId) other.active = false;
      Object.assign(tab, properties);
      return { ...tab };
    },
    get: async (tabId) => {
      const tab = tabs.find(({ id }) => id === tabId);
      if (!tab) throw new Error("missing tab");
      return { ...tab };
    },
    focusWindow: async (windowId) => { focusedWindows.push(windowId); },
    complete: (tabId, url) => {
      const tab = tabs.find(({ id }) => id === tabId);
      if (tab) {
        tab.status = "complete";
        if (url) tab.url = url;
        for (const listener of listeners) listener(tabId, { status: "complete", url }, { ...tab });
      }
    },
    onUpdated: {
      addListener: (listener) => { listeners.add(listener); },
      removeListener: (listener) => { listeners.delete(listener); }
    }
  };
}

test("source identity ignores Text Fragments and safe trailing slashes but preserves queries", () => {
  assert.equal(sourceIdentity("https://research.example/paper/#:~:text=quoted%20words"), sourceIdentity("https://research.example/paper"));
  assert.notEqual(sourceIdentity("https://research.example/paper?doc=1"), sourceIdentity("https://research.example/paper?doc=2"));
});

test("a missing source tab creates one Text Fragment destination and anchors after load", async () => {
  const api = tabsApi();
  const navigationUrl = "https://research.example/paper?doc=1#:~:text=exact%20evidence";
  const operation = openOrReuseAndAnchor(api, "https://research.example/paper?doc=1", navigationUrl, 9, async (tabId) => tabId === 101);
  await new Promise((resolve) => setTimeout(resolve, 0));
  api.complete(101, navigationUrl);
  const result = await operation;
  assert.equal(api.created.length, 1);
  assert.deepEqual(api.created[0], { url: navigationUrl, active: true, windowId: 9 });
  assert.equal(result.selection.reused, false);
  assert.equal(result.loaded, true);
  assert.equal(result.anchored, true);
  assert.equal(api.listeners.size, 0);
});

test("an existing source tab is activated and anchored without another tab or navigation", async () => {
  const api = tabsApi([{ id: 12, windowId: 9, url: "https://research.example/paper#:~:text=older", status: "complete", active: false }]);
  const result = await openOrReuseAndAnchor(api, "https://research.example/paper", "https://research.example/paper#:~:text=new", 9, async (tabId) => tabId === 12);
  assert.equal(api.created.length, 0);
  assert.deepEqual(api.updates, [{ tabId: 12, properties: { active: true } }]);
  assert.equal(api.tabs[0].url, "https://research.example/paper#:~:text=older", "reusing a tab never changes its URL");
  assert.equal(result.selection.reused, true);
  assert.equal(result.anchored, true);
});

test("an already active source tab is anchored in place without navigation or reactivation", async () => {
  const api = tabsApi([{ id: 12, windowId: 9, url: "https://research.example/paper", status: "complete", active: true }]);
  const anchoredTabs: number[] = [];
  const result = await openOrReuseAndAnchor(api, "https://research.example/paper", "https://research.example/paper#:~:text=new", 9, async (tabId) => { anchoredTabs.push(tabId); return true; });
  assert.equal(result.selection.tabId, 12);
  assert.equal(result.selection.wasActive, true);
  assert.deepEqual(anchoredTabs, [12]);
  assert.equal(api.created.length, 0);
  assert.equal(api.updates.length, 0);
});

test("a second passage from the same source reuses the tab opened for the first", async () => {
  const api = tabsApi();
  const sourceUrl = "https://research.example/paper?doc=1";
  const first = openOrReuseAndAnchor(api, sourceUrl, `${sourceUrl}#:~:text=first`, 9, async () => true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  api.complete(101, `${sourceUrl}#:~:text=first`);
  const firstResult = await first;
  const secondResult = await openOrReuseAndAnchor(api, "https://research.example/paper/?doc=1#:~:text=second", "https://research.example/paper/?doc=1#:~:text=second", 9, async (tabId) => tabId === firstResult.selection.tabId);
  assert.equal(api.created.length, 1);
  assert.equal(secondResult.selection.tabId, firstResult.selection.tabId);
  assert.equal(secondResult.selection.reused, true);
  assert.equal(api.tabs[0].url, `${sourceUrl}#:~:text=first`, "the existing URL and page state are retained");
});

test("matching tabs prefer the current window, then active, recently used, and stable order", () => {
  const chosen = chooseExistingSourceTab([
    { id: 1, windowId: 9, url: "https://research.example/paper", active: false, lastAccessed: 900, index: 0 },
    { id: 2, windowId: 10, url: "https://research.example/paper", active: true, lastAccessed: 1000, index: 0 },
    { id: 3, windowId: 9, url: "https://research.example/paper/", active: true, lastAccessed: 500, index: 2 },
    { id: 4, windowId: 9, url: "https://research.example/paper", active: false, lastAccessed: 1200, index: 1 }
  ], "https://research.example/paper#:~:text=evidence", 9);
  assert.equal(chosen?.id, 3);
  assert.equal(chooseExistingSourceTab([
    { id: 5, windowId: 9, url: "https://research.example/paper", active: false, lastAccessed: 10, index: 0 },
    { id: 6, windowId: 9, url: "https://research.example/paper", active: false, lastAccessed: 20, index: 1 }
  ], "https://research.example/paper", 9)?.id, 6, "uses recency when no matching tab is active");
  assert.equal(chooseExistingSourceTab([
    { id: 7, windowId: 9, url: "https://research.example/paper", active: false, index: 2 },
    { id: 8, windowId: 9, url: "https://research.example/paper", active: false, index: 1 }
  ], "https://research.example/paper", 9)?.id, 8, "falls back to stable tab order when recency is unavailable");
});

test("a matching tab in another window is focused rather than duplicated when no current-window match exists", async () => {
  const api = tabsApi([{ id: 12, windowId: 10, url: "https://research.example/paper", status: "complete", active: true }]);
  const result = await activateOrCreateSourceTab(api, "https://research.example/paper", "https://research.example/paper#:~:text=evidence", 9);
  assert.equal(result.tabId, 12);
  assert.deepEqual(api.focusedWindows, [10]);
  assert.equal(api.created.length, 0);
});

test("an anchoring failure keeps the source tab selected and does not create a duplicate", async () => {
  const api = tabsApi([{ id: 12, windowId: 9, url: "https://research.example/paper", status: "complete", active: false }]);
  const result = await openOrReuseAndAnchor(api, "https://research.example/paper", "https://research.example/paper#:~:text=evidence", 9, async () => false);
  assert.equal(result.loaded, true);
  assert.equal(result.anchored, false);
  assert.equal(result.selection.tabId, 12);
  assert.equal(api.created.length, 0);
  assert.equal(api.tabs[0].active, true);
});
