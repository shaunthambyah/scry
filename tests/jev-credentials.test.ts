import assert from "node:assert/strict";
import test from "node:test";
import { clearJevApiKey, readJevApiKey, saveJevApiKey } from "../src/storage/jevCredentials.js";

test("Jev API key storage saves trimmed values and supports replacement and removal", async () => {
  const data: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) { return { [key]: data[key] }; },
        async set(items: Record<string, unknown>) { Object.assign(data, items); },
        async remove(key: string) { delete data[key]; }
      }
    }
  };

  assert.equal(await readJevApiKey(), null);
  await saveJevApiKey("  dev-key-1  ");
  assert.equal(await readJevApiKey(), "dev-key-1");
  await saveJevApiKey("dev-key-2");
  assert.equal(await readJevApiKey(), "dev-key-2");
  await clearJevApiKey();
  assert.equal(await readJevApiKey(), null);
  await assert.rejects(saveJevApiKey("  "), /Enter an API key/);
});
