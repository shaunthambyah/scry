import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function luminance(rgb: number[]): number {
  const linear = rgb.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: number[], second: number[]): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHex(value: string): number[] {
  return value.match(/[A-Fa-f0-9]{2}/g)!.map((part) => Number.parseInt(part, 16));
}

test("palette uses the supplied blue-gray identity and keeps essential text accessible", () => {
  const tokens = readFileSync("src/shared/theme.css", "utf8");
  const panelCss = readFileSync("src/sidepanel/panel.css", "utf8");
  const optionsCss = readFileSync("src/options/options.css", "utf8");
  const contentCss = readFileSync("src/content/googleSerp.css", "utf8");
  const fontsCss = readFileSync("src/shared/fonts/fonts.css", "utf8");
  const white = parseHex(tokens.match(/--scry-white:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const gray = parseHex(tokens.match(/--scry-gray:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const mist = parseHex(tokens.match(/--scry-mist:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const ink = parseHex(tokens.match(/--scry-ink:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const blue = parseHex(tokens.match(/--scry-blue:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const strongBlue = parseHex(tokens.match(/--scry-blue-strong:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const muted = parseHex(tokens.match(/--scry-muted:\s*(#[0-9A-Fa-f]{6})/)![1]);
  const quiet = parseHex(tokens.match(/--scry-muted-soft:\s*(#[0-9A-Fa-f]{6})/)![1]);
  assert.deepEqual(white, [255, 255, 255]);
  assert.deepEqual(gray, [162, 162, 162]);
  assert.deepEqual(mist, [212, 221, 226]);
  assert.deepEqual(blue, [92, 126, 143]);
  assert.ok(contrast(ink, white) >= 4.5);
  assert.ok(contrast(strongBlue, white) >= 4.5);
  assert.ok(contrast(muted, white) >= 4.5);
  assert.ok(contrast(quiet, white) >= 4.5);
  assert.match(panelCss, /\.tab\.active[^}]*color:\s*var\(--scry-blue-strong\)/);
  assert.match(panelCss, /\.match[^}]*color:\s*var\(--scry-blue-strong\)/);
  assert.match(tokens, /--scry-font-reading:\s*"Open Sans"/);
  assert.match(tokens, /--scry-font-title:\s*"Merriweather"/);
  assert.match(panelCss, /\.passage-text[^}]*font-family:\s*var\(--scry-font-reading\)/);
  assert.match(panelCss, /\.dossier-title[^}]*font-family:\s*var\(--scry-font-title\)/);
  assert.match(panelCss, /\.coverage-map[^}]*height:\s*14px/);
  assert.match(panelCss, /\.coverage-segment[^}]*min-width:\s*10px/);
  assert.match(fontsCss, /font-family:\s*'Open Sans'[\s\S]*?font-weight:\s*400\s+700/);
  assert.match(fontsCss, /font-family:\s*'Merriweather'[\s\S]*?font-weight:\s*300\s+900/);
  assert.doesNotMatch(fontsCss, /https:\/\//, "font faces load from packaged local assets");
  assert.doesNotMatch(`${tokens}\n${panelCss}\n${optionsCss}\n${contentCss}`, /#F5EBDD|#F2765E|#413333|#FBF7F0|--scry-coral|\bgreen\b|\bcoral\b/i);
});
