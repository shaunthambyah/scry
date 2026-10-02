declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(callback: (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
    function getURL(path: string): string;
  }
  interface Tab {
    id?: number;
    windowId?: number;
    url?: string;
    status?: string;
    active?: boolean;
    lastAccessed?: number;
    index?: number;
  }
  namespace tabs {
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; windowId?: number }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(createProperties: { url?: string; active?: boolean; windowId?: number }): Promise<Tab>;
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: { url?: string; status?: string }, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: { url?: string; status?: string }, tab: Tab) => void): void;
    };
  }
  namespace windows {
    function update(windowId: number, updateInfo: { focused?: boolean }): Promise<unknown>;
  }
  namespace scripting {
    function executeScript<T = unknown>(options: {
      target: { tabId: number };
      func: (...args: any[]) => T;
      args?: unknown[];
    }): Promise<Array<{ frameId: number; result?: T }>>;
  }
  namespace sidePanel {
    function setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
    function open(options: { tabId: number }): Promise<void>;
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  }
  namespace permissions {
    function request(options: { origins?: string[] }): Promise<boolean>;
    function contains(options: { origins?: string[] }): Promise<boolean>;
  }
  namespace webRequest {
    interface BeforeRedirectDetails { url: string; redirectUrl: string }
    interface BeforeRedirectEvent {
      addListener(callback: (details: BeforeRedirectDetails) => void, filter: { urls: string[] }): void;
    }
    const onBeforeRedirect: BeforeRedirectEvent;
  }
  namespace storage {
    const local: {
      get(keys?: string | string[] | null): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    const session: {
      get(keys?: string | string[] | null): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  }
  namespace offscreen {
    function hasDocument(): Promise<boolean>;
    function createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  }
}
