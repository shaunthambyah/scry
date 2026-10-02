import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
const extensionDir = "dist/extension";
await mkdir(extensionDir, { recursive: true });
await mkdir(`${extensionDir}/shared`, { recursive: true });

const common = { platform: "browser", target: "chrome114", logLevel: "info" };
await Promise.all([
  build({ ...common, entryPoints: ["src/content/googleSerp.ts"], outfile: `${extensionDir}/content/googleSerp.js`, bundle: true, format: "iife" }),
  build({ ...common, entryPoints: ["src/background/serviceWorker.ts"], outfile: `${extensionDir}/background/serviceWorker.js`, bundle: true, format: "esm" }),
  build({ ...common, entryPoints: ["src/offscreen/parser.ts"], outfile: `${extensionDir}/offscreen/parser.js`, bundle: true, format: "iife" }),
  build({ ...common, entryPoints: ["src/sidepanel/panel.ts"], outfile: `${extensionDir}/sidepanel/panel.js`, bundle: true, format: "iife" }),
  build({ ...common, entryPoints: ["src/options/options.ts"], outfile: `${extensionDir}/options/options.js`, bundle: true, format: "iife" }),
  build({
    ...common,
    entryPoints: [
      "src/models/types.ts",
      "src/content/googleSerpParser.ts",
      "src/extraction/extractMainContent.ts",
      "src/extraction/segmentPassages.ts",
      "src/ranking/prefilter.ts",
      "src/ranking/evidencePolicy.ts",
      "src/ranking/jevClient.ts",
      "src/scoring/clefProtocol.ts",
      "src/scoring/cloudflareClefScorer.ts",
      "src/scoring/rankFusion.ts",
      "src/ranking/pageScore.ts",
      "src/pipeline/researchPipeline.ts"
    ],
    outbase: "src",
    outdir: "dist/modules",
    bundle: false,
    format: "esm"
  })
]);

await Promise.all([
  cp("manifest.template.json", `${extensionDir}/manifest.json`),
  cp("src/sidepanel/index.html", `${extensionDir}/sidepanel/index.html`),
  cp("src/sidepanel/panel.css", `${extensionDir}/sidepanel/panel.css`),
  cp("src/options/index.html", `${extensionDir}/options/index.html`),
  cp("src/options/options.css", `${extensionDir}/options/options.css`),
  cp("src/offscreen/index.html", `${extensionDir}/offscreen/index.html`),
  cp("src/content/googleSerp.css", `${extensionDir}/content/googleSerp.css`),
  cp("src/shared/theme.css", `${extensionDir}/shared/theme.css`),
  cp("src/shared/fonts", `${extensionDir}/shared/fonts`, { recursive: true }),
  cp("icons", `${extensionDir}/icons`, { recursive: true })
]);

console.log(`Built isolated unpacked extension in ${extensionDir}/ (project .env is not copied).`);
