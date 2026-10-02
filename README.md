# Scry

A Manifest V3 Chrome extension that uses Google's currently loaded organic results as candidate pages, then ranks source passages across those pages. The default **Grouped** view presents ranked source dossiers; **Passages** exposes the global passage ranking. Use the split **Research these results** control to run the remembered scorer or choose Clef Flash, Clef, Jev, or Consensus for one search. Settings still defines the durable default. Clef requests go through the optional constrained Cloudflare Worker; the extension never contains a Cloudflare credential.

## Architecture

- `src/content/googleSerpParser.ts` implements the isolated `SearchResultProvider` for Google's visible SERP. `src/content/googleSerp.ts` adds the page button and query-change signal.
- `src/content/googleSerpParser.ts` reads result links from the loaded Google page. If Google wraps a result in an opaque `/goto` URL, `src/background/serviceWorker.ts` asks Google for the redirect destination when a run starts, without following the redirect. It checks optional access for the destination sites, fetches pages with a four-request limit, snapshots the scorer selection, and stores the transient candidate set and judgments in `chrome.storage.session`. **Add model** scores those frozen candidates directly without fetching or extracting pages again. If page access is missing, the side panel asks the user to choose **Allow page access**; its click handler requests only those site permissions directly from Chrome.
- Domain, favicon, and title links use ordinary browser navigation. A plain click on an evidence passage first reuses a matching open source tab, preferring the originating window; it activates the tab without changing its URL, scrolls to the exact passage, and replaces the previous Scry highlight. Only when the source is not open does the worker create one tab with a contextual native Text Fragment, then verify/highlight the exact text with `chrome.scripting`. URL identity ignores fragments and a trailing slash but retains query parameters. A failed anchor leaves the selected page open without creating another tab.
- `src/options/` provides the default scoring mode, a Cloudflare Worker URL, and optional Jev API credentials. `src/storage/scoringSettings.ts` stores the default separately from the user's most recent per-search choice.
- `src/offscreen/` parses destination HTML in an MV3 offscreen document. `src/extraction/extractMainContent.ts` uses Mozilla Readability with a structural fallback, removes common page furniture, and preserves article structure; `segmentPassages.ts` creates deterministic passages with document offsets.
- `src/ranking/prefilter.ts` keeps up to 16 likely passages per page. All pages are fetched, extracted, segmented, and prefiltered before the run candidate set is frozen and scored. `src/models/types.ts` defines the provider-neutral `PassageScorer` interface. `jevClient.ts` contains the local development scorer and Jev adapter; `src/scoring/cloudflareClefScorer.ts` shares one batched adapter for Clef and Clef Flash. `src/scoring/rankFusion.ts` centralizes equal-weight Reciprocal Rank Fusion (RRF, `k = 60`) and deterministic model ranking. In Consensus, source aggregation uses `1 / log2(fusedRank + 1)` as a bounded monotonic ordering utility with the existing diminishing-return weights; neither RRF nor this utility is presented as a relevance probability. `evidencePolicy.ts` controls single-model relevance presentation, filtering, and deduplication. `pageScore.ts` orders source dossiers over at most five distinct useful passages.
- `src/pipeline/researchPipeline.ts` coordinates source work, updates progress, rejects failed provenance checks, ignores cancelled runs, and removes duplicate canonical pages from the evidence pool.
- `src/sidepanel/` renders ranked source dossiers, a raw global Passages list, and clickable document coverage bars. Segment spans use document offsets and document length; when offsets are unavailable, source order and passage text length provide a deterministic estimate. Clicking either a section or its passage synchronizes selection, while passage links retain their source click-through behavior. Evidence text uses bundled Open Sans and source titles use bundled Merriweather; their OFL licenses and local WOFF2 subsets live in `src/shared/fonts/`. Source text stays verbatim and separate from machine relevance judgments. Shared palette and font tokens live in `src/shared/theme.css`.

## Setup and build

Requirements: Node.js 20 or newer and npm.

```sh
npm ci
npm run typecheck
npm run build
```

The build creates the unpacked extension in `dist/extension/`. It copies the manifest template, generated JavaScript, Chrome icons, and required UI assets; local `.env` and Wrangler configuration stay outside the package. `assets/scry-icon-master.png` is the supplied source artwork and `icons/` contains the Chrome-sized PNGs.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `dist/extension/`.
4. Open a Google search results page and press **Research these results**.
5. If page access is missing, the side panel explains why it is needed. Choose **Allow page access** and approve Chrome's prompt for the result sites in this run. If Chrome does not show a prompt, open **Manage extensions → Scry → Site access** and allow those sites. Chrome remembers granted site access until you revoke it.
6. Open **Settings** to change the default scoring mode. Automatic uses a saved Jev key when available and otherwise uses the local scorer. To use Clef, deploy the Worker described below and save the Worker /score URL; Chrome will request access to that host. The local development scorer remains available in Settings but is excluded from Consensus.

To use Scry in an Incognito window, open **Manage extensions → Scry → Details** at `chrome://extensions` and turn on **Allow in Incognito**. Chrome keeps this off until you enable it for the extension.

The Incognito setting is separate from Google site access. If the page control does not appear, open Chrome's **Extensions** menu on a Google results tab, open Scry's site access menu, and allow access on `www.google.com` (or choose **On all sites**). Reload the search tab afterward.

The toolbar extension button also opens the research side panel. Chrome 116 or newer is required for the programmatic Side Panel API used here. The manifest includes the `scripting` permission for click-to-source fallback anchoring; injection only runs on a source page after optional page access has been granted.

To update a locally loaded copy after changing the source, run `npm run build`, open `chrome://extensions`, and click **Reload** on Scry. The loaded folder should be `dist/extension/`. Close and reopen the side panel after reloading so it uses the new UI. When page access is missing, either **Allow page access** or the header retry button requests only the result-site permissions; the run resumes after Chrome grants them.

## Tests and local fixture run

```sh
npm test
npm run fixtures
```

Tests use saved SERP and article HTML under `fixtures/`; they do not access Google or destination websites. The suite covers source dossiers, raw-relevance and global-rank ordering, source-rank deduplication, inline expansion, map offsets and interaction, exact Text Fragment construction, duplicate-occurrence anchoring, single-highlight replacement, normalized tab matching, activation/reuse, new-tab creation, deterministic selection among duplicates, anchor failure without duplicate creation, provenance, site-specific and provider host-permission lifecycle, and extension packaging. `npm run fixtures` builds the extension, parses the saved SERP and three local destination pages, runs the same segmentation/prefilter/scoring pipeline, and verifies every displayed passage against the extracted source text.

## Scorer providers and settings

`MockPassageScorer` in `src/ranking/jevClient.ts` uses query-term coverage, a small term-density signal, and a phrase bonus. It returns numeric relevance, an evidence-strength tie-breaker, and a coarse relation. It is a development heuristic, not Jev and not a research-quality judgment.

In **Settings**, choose the default: Automatic, Local development scorer, Jev, Clef Flash, Clef, or Consensus. On Google, the split button remembers the last per-search choice; its main action immediately uses that mode. The scorer selection and RRF configuration are snapshotted when a run starts. Consensus includes every currently available configured real decision model and needs at least two; it never includes the local mock scorer. A completed single-model run can be upgraded with **+ Add model**, which reuses its session-only frozen passages and existing judgments. Consensus shows fused ranks rather than percentages. Use **Settings** to save or remove a Jev API key. It stays in this Chrome profile and is not synced. Treat it as extractable by anyone who can inspect the unpacked extension or browser profile; use a restricted development key. Saving the key requests optional access to `api.typesafe.ai`; if access is denied, Jev is marked unavailable in the Google scorer menu.

`TypeSafeJevTransport` posts to `https://api.typesafe.ai/v1/systemone` with Bearer authentication and model `jev-latest`. It sends the query and each page's prefiltered source passages as structured state, with one typed `score` question per passage. TypeSafe's 0–4 score is normalized to relevance 0–1 and mapped back to the original passage object. Rate limits (429/529) receive bounded retries; run cancellation and a request timeout abort scoring. The mock scorer remains active when no key is saved or the optional API host permission is absent. API keys in browser extensions are not secret storage; use a backend proxy before distributing the extension.

## Cloudflare Clef Worker

The extension sends `{ model, query, passages }` to a narrow scoring route. The Worker allowlists `clef` and `clef-flash`, limits the request to 32 passages, checks query/context/text sizes and unique IDs, constructs one `noul` question per passage, then maps each `answers[questionId].noul` probability back to the original passage ID. The yes probability is relevance in `[0,1]`; the exact source text remains owned by Scry.

Deploy the included Worker with Wrangler:

```sh
npx wrangler login
cp wrangler.example.toml wrangler.toml
# Set ALLOWED_ORIGIN to chrome-extension://<your-extension-id> and choose a unique rate-limit namespace_id.
npx wrangler deploy
```

`wrangler.toml` is local deployment configuration and is ignored by Git. Keep it out of commits; use `wrangler.example.toml` as the safe template.

The Worker uses the Workers AI `AI` binding (`env.AI.run`) for `@cf/cloudflare/clef-flash` and `@cf/cloudflare/clef`. Configure a unique rate-limit `namespace_id` in `wrangler.toml`; its default is 60 calls/minute per client IP and Cloudflare location. The endpoint rejects requests unless the `Origin` exactly matches `ALLOWED_ORIGIN`, and the rate limit is a coarse abuse control, not user authentication. Keep this Worker dedicated to Scry, monitor its use, and rotate/disable it if needed. The request schema and allowlist prevent it from becoming a general model proxy. Cloudflare authentication stays in the Worker platform binding; no Cloudflare token is placed in Scry Settings or extension assets. Save the deployed `/score` URL in Settings and select Clef Flash or Clef.

The operational batch size is 32 passages (configurable in `src/scoring/clefProtocol.ts`) and never exceeds Clef’s 64-question limit. A passage’s heading and adjacent text are optional context; its ID and exact text are preserved. Missing, unknown, or malformed answers fail the batch instead of receiving a made-up score. Abort signals and a 45-second request timeout cover cancellation.

## Data handling

The compact provenance row collapses after completion and expands to show per-source status. Scry keeps the active run in Chrome session storage so it can restore the side panel and let the user add a model to the same frozen passages. The session is replaced by the next research run and cleared when the browser session ends. The extension does not inspect browsing history and does not crawl additional Google result pages.

See [PRIVACY.md](PRIVACY.md) for a plain-language description of the data processed locally and sent to configured scoring providers.

## License

The extension source code is MIT licensed; see [LICENSE](LICENSE). The bundled Open Sans and Merriweather fonts have their own OFL license files in `src/shared/fonts/`. The supplied Scry icon artwork and its derived PNGs are project branding and are not covered by the code license.

## Limitations and fragile assumptions

- Google parsing expects a search input named `q`, result headings inside `#search`, and usually `.MjjYud` or `div[data-hveid]` wrappers. It also excludes common ad containers (`#tads`, `#tadsb`, `[data-text-ad]`) and visible “Sponsored” labels. Google may change these selectors or serve a different layout; the parser is isolated and covered by a saved fixture.
- Destination extraction uses Mozilla Readability first and a compact article/main plus paragraph text/link-density heuristic as fallback. Highly dynamic pages, paywalls, unusual layouts, PDFs, and pages requiring cookies or scripts may fail or produce sparse text.
- Text Fragment behavior depends on Chrome's native matching for newly opened pages. Existing source tabs are not reloaded or given a new fragment; the extension scrolls to a whitespace-normalized exact match in the already rendered page. The active Scry mark uses only a soft slate-blue background and is replaced on the next evidence click. If anchoring fails, the source remains open and no semantic matching is attempted.
- Extracted block text collapses runs of HTML whitespace to a single space. Passage wording is then immutable within that extracted text, and offsets are checked before evidence is rendered.
- Optional host access is requested only for the result sites in the active run, after a direct side-panel user action. Later searches check those grants and do not prompt again. If access is denied or revoked, research waits for the user to grant it from the side panel. Evidence links preserve native Text Fragment destinations for modified clicks and as a recovery path if the worker is unavailable. TypeSafe API and Scoring Worker access are requested separately from Settings. A site block, timeout, or non-HTML response fails only that source.
- The mock scorer ranks lexical overlap. The extension does not synthesize an answer.
- Canonical duplicates are detected after retrieval and represented once in the evidence pool, so a duplicate result can still incur a fetch.

## Next experiments

1. Compare researchers' passage judgments with Google rank and the mock/real scorer ordering.
2. Compare Clef Flash, Clef, Jev, and local scores on identical frozen passages with blinded researcher labels, then tune the relevance question and evaluate latency against judged fixtures.
3. Measure prefilter recall against exhaustive passage scoring before changing its per-page limit.
4. Add fixtures from more Google locales and representative article layouts, then adjust the isolated SERP and extraction heuristics. The content script currently matches common Google domains, including `.com.au`, `.co.uk`, `.ca`, and `.co.nz`.
