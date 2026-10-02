import assert from "node:assert/strict";
import test from "node:test";
import { readRecentScoringMode, readScoringSettings, saveCloudflareWorkerUrl, saveRecentScoringMode, saveScoringModel } from "../src/storage/scoringSettings.js";

test("scoring settings persist the next-run model and Worker URL without a Cloudflare credential", async () => {
  const data: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: {
      async get(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, data[key]])); },
      async set(items: Record<string, unknown>) { Object.assign(data, items); }
    } }
  };
  assert.deepEqual(await readScoringSettings(), { model: "auto", cloudflareWorkerUrl: "" });
  await saveScoringModel("clef-flash");
  await saveCloudflareWorkerUrl("https://worker.example/score");
  assert.deepEqual(await readScoringSettings(), { model: "clef-flash", cloudflareWorkerUrl: "https://worker.example/score" });
  assert.deepEqual(Object.keys(data).sort(), ["scryCloudflareWorkerUrl", "scryScoringModel"]);
  await assert.rejects(saveCloudflareWorkerUrl("http://worker.example/score"), /HTTPS/);
  await assert.rejects(saveCloudflareWorkerUrl("https://worker.example/other"), /\/score/);
  await assert.rejects(saveCloudflareWorkerUrl("https://token@worker.example/score"), /credentials/);
  await saveScoringModel("consensus");
  await saveRecentScoringMode("clef-flash");
  assert.equal((await readScoringSettings()).model, "consensus");
  assert.equal(await readRecentScoringMode(), "clef-flash");
});
