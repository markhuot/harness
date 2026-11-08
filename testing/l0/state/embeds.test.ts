import { expect, test } from "bun:test";
import { EMBED_DEFAULT_HEIGHT, EMBED_MAX_HEIGHT, embedSizeAfter, initialEmbedSize, type EmbedSize } from "../../../shared/src/state/embeds";

const after = (reports: unknown[], from: EmbedSize = initialEmbedSize()) => reports.reduce<EmbedSize>((s, r) => embedSizeAfter(s, r), from);

test("an embed starts at the default height and follows the page up and down", () => {
  expect(initialEmbedSize().height).toBe(EMBED_DEFAULT_HEIGHT);
  expect(after([812.4]).height).toBe(813);
  expect(after([812, 120]).height).toBe(120);
});

test("a reported height above the ceiling is held there", () => {
  expect(after([EMBED_MAX_HEIGHT * 3]).height).toBe(EMBED_MAX_HEIGHT);
});

test("anything but a positive number is ignored", () => {
  for (const bad of [0, -5, NaN, Infinity, "900", null, { height: 900 }]) expect(after([500, bad]).height).toBe(500);
});

test("a page that grows by the same step again and again is tracking its frame: the embed stops following it", () => {
  const s = after([376, 392, 408, 424, 440, 456]);
  expect(s.locked).toBe(true);
  expect(s.height).toBe(408);
  // Once locked, nothing moves it.
  expect(embedSizeAfter(s, 100).height).toBe(408);
});

test("a page that grows in uneven steps (a chart loading, a node expanding) keeps being followed", () => {
  const s = after([400, 450, 470, 900, 1300, 1310]);
  expect(s).toMatchObject({ height: 1310, locked: false });
});
