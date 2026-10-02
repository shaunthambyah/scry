import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasResearchHostPermission, requestResearchHostPermission, researchHostOrigins, RESEARCH_HOST_ORIGINS, type HostPermissionsApi } from "../src/background/hostPermissions.js";

function permissionHarness(initiallyGranted: boolean, grantRequest = true): {
  api: HostPermissionsApi;
  counts: { contains: number; request: number };
  revoke(): void;
} {
  let granted = initiallyGranted;
  const counts = { contains: 0, request: 0 };
  const api: HostPermissionsApi = {
    async contains(permission) {
      counts.contains += 1;
      assert.deepEqual(permission.origins, [...RESEARCH_HOST_ORIGINS]);
      return granted;
    },
    async request(permission) {
      counts.request += 1;
      assert.deepEqual(permission.origins, [...RESEARCH_HOST_ORIGINS]);
      granted = grantRequest;
      return granted;
    }
  };
  return { api, counts, revoke: () => { granted = false; } };
}

test("already-granted broad page access continues without a permission request", async () => {
  const { api, counts } = permissionHarness(true);
  assert.equal(await hasResearchHostPermission(api), true);
  assert.deepEqual(counts, { contains: 1, request: 0 });
});

test("missing access is only detected in the worker; the side panel can request it directly", async () => {
  const { api, counts } = permissionHarness(false, true);
  assert.equal(await hasResearchHostPermission(api), false);
  assert.deepEqual(counts, { contains: 1, request: 0 });
  assert.equal(await requestResearchHostPermission(api), true);
  assert.equal(await hasResearchHostPermission(api), true);
  assert.deepEqual(counts, { contains: 2, request: 1 });
});

test("a second search after authorization checks access and produces no second prompt", async () => {
  const { api, counts } = permissionHarness(false, true);
  assert.equal(await hasResearchHostPermission(api), false);
  assert.equal(await requestResearchHostPermission(api), true);
  assert.equal(await hasResearchHostPermission(api), true);
  assert.equal(await hasResearchHostPermission(api), true);
  assert.deepEqual(counts, { contains: 3, request: 1 });
});

test("denied access does not rerun research", async () => {
  const { api, counts } = permissionHarness(false, false);
  assert.equal(await hasResearchHostPermission(api), false);
  assert.equal(await requestResearchHostPermission(api), false);
  assert.equal(await hasResearchHostPermission(api), false);
  assert.deepEqual(counts, { contains: 2, request: 1 });
});

test("revoked access is requested again on the next research attempt", async () => {
  const { api, counts, revoke } = permissionHarness(true, true);
  assert.equal(await hasResearchHostPermission(api), true);
  revoke();
  assert.equal(await hasResearchHostPermission(api), false);
  assert.equal(await requestResearchHostPermission(api), true);
  assert.deepEqual(counts, { contains: 2, request: 1 });
});

test("result permissions are deduplicated, site-specific, and ignore invalid schemes", async () => {
  assert.deepEqual(researchHostOrigins([
    "https://www.example.com:8443/article?id=1",
    "https://www.example.com/other",
    "http://news.example.net/story",
    "file:///tmp/article",
    "not a URL"
  ]), ["http://news.example.net/*", "https://www.example.com/*"]);
  const requested: string[][] = [];
  const api: HostPermissionsApi = {
    async contains(permission) { requested.push(permission.origins); return true; },
    async request(permission) { requested.push(permission.origins); return true; }
  };
  const origins = ["https://www.example.com/*"];
  assert.equal(await hasResearchHostPermission(api, origins), true);
  assert.equal(await requestResearchHostPermission(api, origins), true);
  assert.deepEqual(requested, [origins, origins]);
});

test("manifest and worker use broad optional access instead of per-search origins", () => {
  const manifest = JSON.parse(readFileSync("manifest.template.json", "utf8")) as { permissions: string[]; optional_host_permissions: string[]; host_permissions?: string[] };
  const worker = readFileSync("src/background/serviceWorker.ts", "utf8");
  assert.deepEqual(manifest.optional_host_permissions, [...RESEARCH_HOST_ORIGINS]);
  assert.ok(manifest.permissions.includes("scripting"), "destination-page fallback anchoring uses the Chrome scripting API");
  assert.equal(manifest.host_permissions, undefined);
  assert.match(worker, /hasResearchHostPermission\(chrome\.permissions, requiredHostOrigins\)/);
  assert.doesNotMatch(worker, /chrome\.permissions\.request/);
  assert.match(worker, /await chrome\.storage\.session\.set\(\{ \[SESSION_TAB_KEY\]: tabId \}\)/, "the retry can recover its source tab after the service worker suspends");
  assert.doesNotMatch(worker, /chrome\.permissions\.request\(\{\s*origins\s*\}\)/);
});
