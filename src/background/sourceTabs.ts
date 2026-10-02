export interface SourceBrowserTab {
  id?: number;
  windowId?: number;
  url?: string;
  status?: string;
  active?: boolean;
  lastAccessed?: number;
  index?: number;
}

export interface SourceTabsApi {
  query(queryInfo: { windowId?: number }): Promise<SourceBrowserTab[]>;
  create(createProperties: { url: string; active: true; windowId?: number }): Promise<SourceBrowserTab>;
  update(tabId: number, updateProperties: { active: true }): Promise<SourceBrowserTab>;
  get(tabId: number): Promise<SourceBrowserTab>;
  focusWindow?(windowId: number): Promise<unknown>;
  onUpdated: {
    addListener(listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: SourceBrowserTab) => void): void;
    removeListener(listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: SourceBrowserTab) => void): void;
  };
}

export interface SourceTabSelection {
  tabId: number;
  reused: boolean;
  wasActive: boolean;
  loaded: boolean;
}

/** Ignore fragments and a single obvious trailing slash; retain the query string exactly. */
export function sourceIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.href;
  } catch { return null; }
}

export function chooseExistingSourceTab(
  tabs: SourceBrowserTab[],
  sourceUrl: string,
  currentWindowId?: number
): SourceBrowserTab | undefined {
  const identity = sourceIdentity(sourceUrl);
  if (!identity) return undefined;
  return tabs.filter((tab) => tab.id !== undefined && tab.url && sourceIdentity(tab.url) === identity)
    .sort((first, second) => {
      const firstCurrent = currentWindowId !== undefined && first.windowId === currentWindowId ? 1 : 0;
      const secondCurrent = currentWindowId !== undefined && second.windowId === currentWindowId ? 1 : 0;
      return secondCurrent - firstCurrent
        || Number(Boolean(second.active)) - Number(Boolean(first.active))
        || (second.lastAccessed ?? -Infinity) - (first.lastAccessed ?? -Infinity)
        || (first.index ?? Number.MAX_SAFE_INTEGER) - (second.index ?? Number.MAX_SAFE_INTEGER)
        || (first.id ?? Number.MAX_SAFE_INTEGER) - (second.id ?? Number.MAX_SAFE_INTEGER);
    })[0];
}

const pendingByIdentity = new Map<string, Promise<SourceTabSelection>>();

/** Reuses an existing source tab without navigating it; creates only when no match exists. */
export function activateOrCreateSourceTab(
  api: SourceTabsApi,
  sourceUrl: string,
  initialNavigationUrl: string,
  currentWindowId?: number
): Promise<SourceTabSelection> {
  const identity = sourceIdentity(sourceUrl);
  if (!identity) return Promise.reject(new Error("Evidence source URL is not a valid HTTP(S) URL."));
  const pending = pendingByIdentity.get(identity);
  if (pending) return pending;
  const operation = (async (): Promise<SourceTabSelection> => {
    const tabs = await api.query({});
    const existing = chooseExistingSourceTab(tabs, sourceUrl, currentWindowId);
    if (existing?.id !== undefined) {
      if (existing.windowId !== undefined && currentWindowId !== undefined && existing.windowId !== currentWindowId) {
        try { await api.focusWindow?.(existing.windowId); } catch { /* Keep using the matching tab even if Chrome cannot focus its window. */ }
      }
      if (!existing.active) await api.update(existing.id, { active: true });
      return { tabId: existing.id, reused: true, wasActive: Boolean(existing.active), loaded: existing.status === "complete" };
    }
    const created = await api.create({ url: initialNavigationUrl, active: true, ...(currentWindowId === undefined ? {} : { windowId: currentWindowId }) });
    if (created.id === undefined) throw new Error("Chrome did not return an id for the opened source tab.");
    return { tabId: created.id, reused: false, wasActive: false, loaded: created.status === "complete" };
  })();
  pendingByIdentity.set(identity, operation);
  void operation.finally(() => {
    if (pendingByIdentity.get(identity) === operation) pendingByIdentity.delete(identity);
  }).catch(() => undefined);
  return operation;
}

/** Waits for a selected/created source tab to finish its current navigation. */
export async function waitForSourceTabComplete(api: SourceTabsApi, tabId: number, timeoutMs = 20_000): Promise<boolean> {
  try {
    const current = await api.get(tabId);
    if (current.status === "complete") return true;
  } catch { return false; }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      api.onUpdated.removeListener(onUpdated);
      resolve(loaded);
    };
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    api.onUpdated.addListener(onUpdated);
    const poll = async () => {
      if (settled) return;
      try {
        if ((await api.get(tabId)).status === "complete") { finish(true); return; }
      } catch { finish(false); return; }
      if (!settled) setTimeout(() => { void poll(); }, 100);
    };
    void poll();
  });
}

export async function openOrReuseAndAnchor(
  api: SourceTabsApi,
  sourceUrl: string,
  initialNavigationUrl: string,
  currentWindowId: number | undefined,
  anchor: (tabId: number) => Promise<boolean>
): Promise<{ selection: SourceTabSelection; loaded: boolean; anchored: boolean }> {
  const selection = await activateOrCreateSourceTab(api, sourceUrl, initialNavigationUrl, currentWindowId);
  const loaded = selection.loaded || await waitForSourceTabComplete(api, selection.tabId);
  if (!loaded) return { selection, loaded: false, anchored: false };
  return { selection, loaded: true, anchored: await anchor(selection.tabId) };
}
