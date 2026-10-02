import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function pngDimensions(path: string): [number, number] {
  const image = readFileSync(path);
  assert.equal(image.toString("hex", 0, 8), "89504e470d0a1a0a");
  return [image.readUInt32BE(16), image.readUInt32BE(20)];
}

test("unpacked build has its UI assets and never packages local environment files", () => {
  const manifest = JSON.parse(readFileSync("dist/extension/manifest.json", "utf8")) as { manifest_version?: number; name?: string; short_name?: string; description?: string; icons?: Record<string, string>; action?: { default_title?: string; default_icon?: Record<string, string> }; side_panel?: { default_path?: string }; content_scripts?: Array<{ css?: string[] }> };
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Scry");
  assert.equal(manifest.short_name, "Scry");
  assert.equal(manifest.action?.default_title, "Open Scry research");
  const expectedIcons = { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" };
  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action?.default_icon, expectedIcons);
  for (const [size, path] of Object.entries(expectedIcons)) {
    assert.equal(existsSync(`dist/extension/${path}`), true);
    assert.deepEqual(pngDimensions(`dist/extension/${path}`), [Number(size), Number(size)]);
  }
  assert.doesNotMatch(manifest.description ?? "", /Jev|Clef|AI/i);
  assert.equal(manifest.side_panel?.default_path, "sidepanel/index.html");
  assert.ok(manifest.content_scripts?.[0]?.css?.includes("shared/theme.css"));
  assert.ok(manifest.content_scripts?.[0]?.css?.includes("content/googleSerp.css"));
  assert.equal(existsSync("dist/extension/shared/theme.css"), true);
  assert.equal(existsSync("dist/extension/shared/fonts/fonts.css"), true);
  assert.ok(filesUnder("dist/extension/shared/fonts").some((path) => path.endsWith("open-sans-latin.woff2")));
  assert.ok(filesUnder("dist/extension/shared/fonts").some((path) => path.endsWith("merriweather-latin.woff2")));
  assert.equal(existsSync("dist/extension/content/googleSerp.css"), true);
  assert.equal(existsSync("dist/extension/.env"), false);
  assert.equal(existsSync("dist/extension/.env.local"), false);
  assert.deepEqual(filesUnder("dist/extension").filter((path) => /(?:^|[/\\])\.env(?:\.|$)/.test(path)), []);
  const textAssets = filesUnder("dist/extension").filter((path) => /\.(?:js|map|json|html|css)$/.test(path)).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(textAssets, /CLOUDFLARE_(?:API_)?TOKEN\s*[:=]/i);
  assert.doesNotMatch(textAssets, /Bearer\s+[A-Za-z0-9_-]{32,}/);
});
