# Privacy

Last reviewed: 2026-10-02

Scry processes only the Google search and result pages involved in a research run started by the user. It does not read browsing history or automatically fetch additional Google result pages.

## Processed in Chrome

- The current search query and organic result links, titles, and ranks are read from the loaded Google results page. When a link uses Google's opaque `/goto` redirect, Scry requests that redirect after you start a research run and reads its destination from Chrome's redirect event without following it. The redirect listener is limited to Google `/goto` URLs and is used to resolve links in the active run.
- After the user grants access for the sites in that run, Scry fetches those result pages and extracts text needed to form passages.
- The active run and its frozen candidate passages are kept in `chrome.storage.session` so the side panel can survive service-worker restarts and let you add a scorer to the same run. A new run replaces the saved run; Chrome clears session storage when the browser session ends.
- Settings and the optional TypeSafe API key are stored in `chrome.storage.local` in the current Chrome profile. The key is never shown again in the settings page or copied into page content. Browser-profile access can expose it, so use a restricted key.

## Sent to scoring providers

The local development scorer runs in the extension and sends no scoring request over the network. When a remote scorer is selected or configured:

- **Jev / TypeSafe:** Scry sends the search query, prefiltered passages, their heading paths, and available neighboring text to `api.typesafe.ai`. The API key is sent as a Bearer credential.
- **Clef / Clef Flash:** Scry sends the query and prefiltered passages, with available heading and neighboring text, to the Scoring Worker URL saved in Settings. That Worker sends the scoring request to Cloudflare Workers AI and uses the caller IP for its rate limiter.
- **Consensus:** Scry sends the candidate passages to each available configured real scorer. It does not include the local development scorer.

Passage text comes from the result pages the user asked Scry to research. Requests are limited to the selected candidates, and the extension does not send the entire page HTML to the scorer. Provider-side retention and processing are governed by the provider's current terms and privacy policy; Scry does not control them.

Scry contains no analytics or telemetry service. Network activity is limited to resolving Google result redirects after you start a run, fetching the requested result pages after you grant page access, and requests required by the configured scorer.

## Permissions

The extension requests Google host access and the `webRequest` permission to read the current results page and resolve its `/goto` links. It requests access to result-site hosts only when the user starts a run and confirms **Allow page access**. TypeSafe API and Scoring Worker host access are requested separately from Settings. These grants can be reviewed or revoked in Chrome's extension site-access settings.
