import { extractMainContent } from "../extraction/extractMainContent.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PARSE_DESTINATION_HTML") return;
  try {
    const extracted = extractMainContent(String(message.html ?? ""), String(message.url ?? ""));
    sendResponse({ ok: true, extracted, canonicalUrl: extracted.canonicalUrl });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
